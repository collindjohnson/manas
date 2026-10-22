import { createHash, randomUUID } from "node:crypto";
import type { BrainStore } from "./store";
import type { BrainRepository } from "./repository";
import type { OperationContext } from "./operation-registry";
import type { BrainJob } from "./jobs";
import { enqueueJob, cancelJob } from "./jobs";
import { scopedSnapshot } from "./evidence-contract";
import { uuidv5 } from "../utils";

export class ExecutionError extends Error {
 constructor(readonly code: string, readonly retryable = false, readonly suggestedFix = "Inspect the execution receipt and start a corrected, authorized plan.", readonly retryAfterMs = 1000) { super(code); }
}
export const EXECUTION_READ_OPERATIONS = ["retrieval.search", "retrieval.get", "retrieval.related", "memory.recall", "context.deliver", "entities.resolve", "relationships.query", "answers.get", "questions.get", "questions.list"] as const;
export const EXECUTION_WRITE_OPERATIONS = ["entities.put", "relationships.put"] as const;
const reads = new Set<string>(EXECUTION_READ_OPERATIONS), writes = new Set<string>(EXECUTION_WRITE_OPERATIONS);
export interface ExecutionStep { operation: string; input: Record<string, unknown>; maximumOutputTokens?: number; timeoutMs?: number; }
export interface ExecutionBudget { maximumItems: number; maximumTokens: number; maximumRuntimeMs: number; }
type PlanStep = Required<ExecutionStep>;
type Run = { id: string; tenant_id: string; brain_id: string; principal: string; request_hash: string; status: string; plan: PlanStep[]; budget: ExecutionBudget; managed_writes: boolean; items_used: number; tokens_reserved: number; runtime_reserved_ms: number; current_job_id: string; worker_id: string | null; last_error: string | null; retryable: boolean };
type Step = { ordinal: number; operation: string; input: unknown; input_hash: string | null; status: string; attempts: number; result: unknown; result_hash: string | null; error_code: string | null; input_tokens: number; output_tokens: number; duration_ms: number };
export type CatalogExecute = (context: OperationContext, operation: string, input: Record<string, unknown>) => Promise<unknown>;
type Dependencies = { store: BrainStore; repository: BrainRepository; managedWrites?: () => boolean };
function canonical(value: unknown): string {
 if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
 if (object(value)) return "{" + Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
 return JSON.stringify(value) ?? "null";
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "null");
const json = <T>(value: T | string): T => typeof value === "string" ? JSON.parse(value) : value;
function owner(context: OperationContext) {
 if (context.scope !== "admin" || context.allowedAccessLabels !== undefined || context.tenantId && context.tenantId !== "local") throw new ExecutionError("owner_access_required");
 context.signal?.throwIfAborted();
}
function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
 const number = value ?? fallback;
 if (typeof number !== "number" || !Number.isSafeInteger(number) || number < minimum || number > maximum) throw new ExecutionError("invalid_execution_budget");
 return number;
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function planInput(input: { steps: ExecutionStep[]; budget?: Partial<ExecutionBudget> }) {
 if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 32 || bytes(input.steps) > 262144) throw new ExecutionError("invalid_execution_plan");
 if (input.budget !== undefined && (!object(input.budget) || Object.keys(input.budget).some((key) => !["maximumItems", "maximumTokens", "maximumRuntimeMs"].includes(key)))) throw new ExecutionError("invalid_execution_budget");
 const budget: ExecutionBudget = { maximumItems: integer(input.budget?.maximumItems, input.steps.length * 3, 1, 128), maximumTokens: integer(input.budget?.maximumTokens, 131072, 256, 1048576), maximumRuntimeMs: integer(input.budget?.maximumRuntimeMs, 60000, 100, 600000) };
 const plan: PlanStep[] = input.steps.map((step) => {
  if (!object(step) || Object.keys(step).some((key) => !["operation", "input", "maximumOutputTokens", "timeoutMs"].includes(key)) || typeof step.operation !== "string" || !object(step.input) || !reads.has(step.operation) && !writes.has(step.operation)) throw new ExecutionError("execution_operation_denied");
  if (writes.has(step.operation) && ("id" in step.input || "expectedRevision" in step.input || "idempotencyKey" in step.input)) throw new ExecutionError("execution_write_requires_new_owned_record");
  return { operation: step.operation, input: structuredClone(step.input), maximumOutputTokens: integer(step.maximumOutputTokens, 16384, 128, 131072), timeoutMs: integer(step.timeoutMs, 5000, 50, 30000) };
 });
 if (plan.length > budget.maximumItems) throw new ExecutionError("execution_item_budget_exceeded");
 return { plan, budget };
}
async function requireRun(dependencies: Dependencies, context: OperationContext, id: string): Promise<Run> {
 owner(context);
 const snapshot = await scopedSnapshot(dependencies.repository, context);
 const rows = await dependencies.store.query<Run>("SELECT * FROM brain_catalog_executions WHERE id=$1 AND tenant_id='local' AND brain_id=$2", [id, snapshot.brainId]);
 if (!rows[0]) throw new ExecutionError("execution_unavailable");
 return { ...rows[0], plan: json(rows[0].plan), budget: json(rows[0].budget) };
}
export async function startExecution(dependencies: Dependencies, context: OperationContext, input: { idempotencyKey: string; steps: ExecutionStep[]; budget?: Partial<ExecutionBudget> }) {
 owner(context);
 if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128) throw new ExecutionError("invalid_idempotency_key");
 const { plan, budget } = planInput(input);
 const managedWrites = plan.some((step) => writes.has(step.operation));
 if (managedWrites && dependencies.managedWrites?.() !== true) throw new ExecutionError("managed_writes_disabled", false, "Enable automation.managedWrites explicitly, or use a read-only plan and review proposals.");
 const snapshot = await scopedSnapshot(dependencies.repository, context);
 const principal = context.principal ?? "local-owner";
 const requestHash = hash({ plan, budget, managedWrites });
 const id = uuidv5("catalog-execution:" + snapshot.brainId + ":" + principal + ":" + input.idempotencyKey);
 return dependencies.store.transaction(async (transaction) => {
  const initialJobId = randomUUID();
  await transaction.query("INSERT INTO brain_catalog_executions (id,tenant_id,brain_id,principal,request_hash,status,plan,budget,managed_writes,current_job_id) VALUES ($1,'local',$2,$3,$4,'pending',$5::jsonb,$6::jsonb,$7,$8) ON CONFLICT (id) DO NOTHING", [id, snapshot.brainId, principal, requestHash, JSON.stringify(plan), JSON.stringify(budget), managedWrites, initialJobId]);
  const rows = await transaction.query<Run>("SELECT * FROM brain_catalog_executions WHERE id=$1 AND tenant_id='local' AND brain_id=$2 FOR UPDATE", [id, snapshot.brainId]);
  const run = rows[0]!;
  if (run.request_hash !== requestHash || run.principal !== principal) throw new ExecutionError("idempotency_conflict");
  if (run.current_job_id !== initialJobId) return { id, jobId: run.current_job_id, status: run.status, replayed: true };
  for (const [ordinal, step] of plan.entries()) await transaction.query("INSERT INTO brain_catalog_execution_steps (execution_id,ordinal,tenant_id,brain_id,operation,status) VALUES ($1,$2,'local',$3,$4,'pending')", [id, ordinal, snapshot.brainId, step.operation]);
  const job = await enqueueJob(transaction, { type: "catalog-execution", payload: { executionId: id, brainId: snapshot.brainId }, maxAttempts: plan.length * 3, idempotencyKey: "catalog-execution:" + id });
  await transaction.query("UPDATE brain_catalog_executions SET current_job_id=$2 WHERE id=$1", [id, job.id]);
  return { id, jobId: job.id, status: "pending", replayed: false };
 });
}
export async function executionStatus(dependencies: Dependencies, context: OperationContext, input: { id: string; includeHistoricalResults?: boolean }) {
 const run = await requireRun(dependencies, context, input.id);
 const steps = await dependencies.store.query<Step>("SELECT ordinal,operation,input_hash,status,attempts,result,result_hash,error_code,input_tokens,output_tokens,duration_ms FROM brain_catalog_execution_steps WHERE execution_id=$1 AND tenant_id='local' AND brain_id=$2 ORDER BY ordinal", [run.id, run.brain_id]);
 return { id: run.id, status: run.status, jobId: run.current_job_id, budget: run.budget, usage: { items: run.items_used, reservedTokens: run.tokens_reserved, reservedRuntimeMs: run.runtime_reserved_ms }, errorCode: run.last_error, retryable: run.retryable, historicalResults: input.includeHistoricalResults === true, steps: steps.map((step) => ({ ordinal: step.ordinal, operation: step.operation, status: step.status, attempts: step.attempts, resultHash: step.result_hash, inputHash: step.input_hash, errorCode: step.error_code, inputTokens: step.input_tokens, outputTokens: step.output_tokens, durationMs: step.duration_ms, ...(input.includeHistoricalResults ? { result: step.result === null ? null : json(step.result) } : {}) })) };
}
export async function listExecutions(dependencies: Dependencies, context: OperationContext, input: { limit?: number; before?: string }) {
 owner(context);
 const snapshot = await scopedSnapshot(dependencies.repository, context);
 const limit = integer(input.limit, 50, 1, 100);
 const runs = await dependencies.store.query<{ id: string; status: string; created_at: string; last_error: string | null }>("SELECT id,status,created_at,last_error FROM brain_catalog_executions WHERE tenant_id='local' AND brain_id=$1 AND ($2::text IS NULL OR id<$2) ORDER BY id DESC LIMIT $3", [snapshot.brainId, input.before ?? null, limit + 1]);
 return { executions: runs.slice(0, limit).map((run) => ({ id: run.id, status: run.status, createdAt: new Date(run.created_at).toISOString(), errorCode: run.last_error })), ...(runs.length > limit ? { nextCursor: runs[limit - 1]!.id } : {}) };
}
export async function cancelExecution(dependencies: Dependencies, context: OperationContext, id: string) {
 const run = await requireRun(dependencies, context, id);
 await dependencies.store.transaction(async (transaction) => {
  await transaction.query("SELECT id FROM brain_jobs WHERE id=$1 AND tenant_id='local' FOR UPDATE", [run.current_job_id]);
  const cancelled = await transaction.query<{ current_job_id: string }>("UPDATE brain_catalog_executions SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,retryable=false,updated_at=now(),completed_at=now() WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND status IN ('pending','running') RETURNING current_job_id", [id, run.brain_id]);
  if (cancelled[0]) {
   await cancelJob(transaction, cancelled[0].current_job_id, "local");
   await transaction.query("UPDATE brain_catalog_execution_steps SET status='failed',error_code='execution_cancelled' WHERE execution_id=$1 AND tenant_id='local' AND brain_id=$2 AND status='running'", [id, run.brain_id]);
  }
 });
 return executionStatus(dependencies, context, { id });
}
/** References can only select JSON data from an earlier, durably completed step. */
function resolveInput(value: unknown, ordinal: number, results: Map<number, unknown>, depth = 0): unknown {
 if (depth > 20) throw new ExecutionError("invalid_result_reference");
 if (Array.isArray(value)) return value.map((item) => resolveInput(item, ordinal, results, depth + 1));
 if (!object(value)) return value;
 if ("$result" in value) {
  const reference = value.$result;
  if (Object.keys(value).length !== 1 || !object(reference) || Object.keys(reference).some((key) => !["step", "path"].includes(key)) || !Number.isSafeInteger(reference.step) || Number(reference.step) < 0 || Number(reference.step) >= ordinal || !Array.isArray(reference.path) || reference.path.length > 20 || !results.has(Number(reference.step))) throw new ExecutionError("invalid_result_reference");
  let result = results.get(Number(reference.step));
  for (const segment of reference.path) {
   if (!(typeof segment === "string" || typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) || ["__proto__", "prototype", "constructor"].includes(String(segment)) || !result || typeof result !== "object" || !Object.hasOwn(result, segment)) throw new ExecutionError("invalid_result_reference");
   result = (result as Record<string | number, unknown>)[segment];
  }
  return structuredClone(result);
 }
 return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveInput(child, ordinal, results, depth + 1)]));
}
export function catalogExecutionHandler(dependencies: Dependencies & { workerId: string; execute: CatalogExecute; faultInjector?: (point: "after-tool" | "after-step", ordinal: number) => Promise<void> }) {
 return async (job: BrainJob) => {
  const payload = job.payload as { executionId?: unknown; brainId?: unknown };
  if (!payload || typeof payload.executionId !== "string") throw new ExecutionError("invalid_execution_job");
  const context: OperationContext = { scope: "admin", tenantId: "local", brainId: typeof payload.brainId === "string" ? payload.brainId : undefined, principal: "catalog-worker" };
  const initial = await requireRun(dependencies, context, payload.executionId);
  if (job.tenantId !== "local" || initial.current_job_id !== job.id) throw new ExecutionError("execution_job_mismatch");
  if (initial.status === "complete") return;
  if (["failed", "cancelled"].includes(initial.status)) throw new ExecutionError(initial.status === "cancelled" ? "execution_cancelled" : initial.last_error ?? "execution_failed");
  const token = dependencies.workerId + ":" + randomUUID();
  const claimed = await dependencies.store.query<{ id: string }>("UPDATE brain_catalog_executions SET status='running',worker_id=$2,lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE id=$1 AND tenant_id='local' AND brain_id=$3 AND status IN ('pending','running') AND (worker_id IS NULL OR lease_expires_at<=now()) RETURNING id", [initial.id, token, initial.brain_id]);
  if (!claimed.length) throw new ExecutionError("execution_busy", true);
  const controller = new AbortController();
  let lost: unknown, renewal = Promise.resolve();
  const check = async () => {
   controller.signal.throwIfAborted();
   await dependencies.store.transaction(async (transaction) => {
    const owned = await transaction.query<{ id: string }>("UPDATE brain_jobs SET lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE id=$1 AND tenant_id='local' AND worker_id=$2 AND status='running' AND lease_expires_at>now() RETURNING id", [job.id, dependencies.workerId]);
    if (!owned.length) throw new ExecutionError("execution_job_lease_lost", true);
    const lease = await transaction.query<{ id: string }>("UPDATE brain_catalog_executions SET lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND worker_id=$3 AND status='running' AND lease_expires_at>now() RETURNING id", [initial.id, initial.brain_id, token]);
    if (!lease.length) throw new ExecutionError("execution_cancelled_or_lease_lost", true);
   });
   if (initial.managed_writes && dependencies.managedWrites?.() !== true) throw new ExecutionError("managed_writes_disabled");
  };
  const timer = setInterval(() => { renewal = renewal.then(check).catch((error) => { lost = error; controller.abort(error); }); }, 500);
  let activeOrdinal: number | undefined;
  try {
   const saved = await dependencies.store.query<Step>("SELECT * FROM brain_catalog_execution_steps WHERE execution_id=$1 AND tenant_id='local' AND brain_id=$2 ORDER BY ordinal", [initial.id, initial.brain_id]);
   const results = new Map(saved.filter((step) => step.status === "complete").map((step) => [step.ordinal, json(step.result)]));
   for (const [ordinal, step] of initial.plan.entries()) {
    if (results.has(ordinal)) continue;
    if (!reads.has(step.operation) && !writes.has(step.operation)) throw new ExecutionError("execution_operation_denied");
    if (writes.has(step.operation) && (!initial.managed_writes || dependencies.managedWrites?.() !== true)) throw new ExecutionError("managed_writes_disabled");
    activeOrdinal = ordinal; await check();
    const resolved = resolveInput(step.input, ordinal, results);
    if (!object(resolved)) throw new ExecutionError("invalid_result_reference");
    let input = resolved;
    if (step.operation === "retrieval.search") input = { ...input, options: { ...(object(input.options) ? input.options : {}), mode: "keyword" } };
    if (writes.has(step.operation)) {
     if ("id" in input || "expectedRevision" in input || "idempotencyKey" in input) throw new ExecutionError("execution_write_requires_new_owned_record");
     input = { ...input, idempotencyKey: "execution:" + initial.id + ":" + ordinal };
    }
    const inputTokens = bytes(input);
    if (inputTokens > 65536) throw new ExecutionError("execution_input_budget_exceeded");
    await dependencies.store.transaction(async (transaction) => {
     const locked = await transaction.query<{ id: string }>("SELECT id FROM brain_catalog_executions WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND worker_id=$3 AND status='running' AND lease_expires_at>now() FOR UPDATE", [initial.id, initial.brain_id, token]);
     if (!locked.length) throw new ExecutionError("execution_cancelled_or_lease_lost", true);
     const attempt = await transaction.query<{ attempts: number }>("SELECT attempts FROM brain_catalog_execution_steps WHERE execution_id=$1 AND ordinal=$2 AND tenant_id='local' AND brain_id=$3 FOR UPDATE", [initial.id, ordinal, initial.brain_id]);
     if (!attempt[0] || attempt[0].attempts >= 3) throw new ExecutionError("execution_step_attempts_exhausted");
     const admitted = await transaction.query<{ id: string }>("UPDATE brain_catalog_executions SET items_used=items_used+1,tokens_reserved=tokens_reserved+$4,runtime_reserved_ms=runtime_reserved_ms+$5 WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND worker_id=$3 AND status='running' AND lease_expires_at>now() AND items_used+1<=$6 AND tokens_reserved+$4<=$7 AND runtime_reserved_ms+$5<=$8 RETURNING id", [initial.id, initial.brain_id, token, inputTokens + step.maximumOutputTokens, step.timeoutMs, initial.budget.maximumItems, initial.budget.maximumTokens, initial.budget.maximumRuntimeMs]);
     if (!admitted.length) throw new ExecutionError("execution_budget_exhausted");
     await transaction.query("UPDATE brain_catalog_execution_steps SET status='running',attempts=attempts+1,input=$4::jsonb,input_tokens=$5,input_hash=$6,error_code=NULL,started_at=now() WHERE execution_id=$1 AND ordinal=$2 AND tenant_id='local' AND brain_id=$3", [initial.id, ordinal, initial.brain_id, JSON.stringify(input), inputTokens, hash(input)]);
    });
    await check();
    const started = Date.now();
    const deadline = setTimeout(() => controller.abort(new ExecutionError("execution_runtime_budget_exceeded")), step.timeoutMs);
    let result: unknown;
    try { result = await dependencies.execute({ ...context, principal: initial.principal, signal: controller.signal }, step.operation, input); }
    finally { clearTimeout(deadline); }
    controller.signal.throwIfAborted();
    const outputTokens = bytes(result), durationMs = Date.now() - started;
    if (outputTokens > step.maximumOutputTokens) throw new ExecutionError("execution_output_budget_exceeded");
    if (durationMs > step.timeoutMs) throw new ExecutionError("execution_runtime_budget_exceeded");
    await dependencies.faultInjector?.("after-tool", ordinal);
    await check();
    await dependencies.store.transaction(async (transaction) => {
     const owned = await transaction.query<{ id: string }>("SELECT id FROM brain_catalog_executions WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND worker_id=$3 AND status='running' AND lease_expires_at>now() FOR UPDATE", [initial.id, initial.brain_id, token]);
     if (!owned.length) throw new ExecutionError("execution_cancelled_or_lease_lost", true);
     await transaction.query("UPDATE brain_catalog_execution_steps SET status='complete',result=$4::jsonb,result_hash=$5,output_tokens=$6,duration_ms=$7,completed_at=now() WHERE execution_id=$1 AND ordinal=$2 AND tenant_id='local' AND brain_id=$3", [initial.id, ordinal, initial.brain_id, JSON.stringify(result ?? null), hash(result ?? null), outputTokens, durationMs]);
    });
    results.set(ordinal, result);
    await dependencies.faultInjector?.("after-step", ordinal);
   }
   await check();
   await dependencies.store.query("UPDATE brain_catalog_executions SET status='complete',last_error=NULL,retryable=false,completed_at=now(),updated_at=now() WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND worker_id=$3 AND status='running'", [initial.id, initial.brain_id, token]);
  } catch (error) {
   const cause = lost ?? (controller.signal.aborted ? controller.signal.reason : error);
   const code = cause instanceof ExecutionError ? cause.code : typeof (cause as { code?: unknown })?.code === "string" ? (cause as { code: string }).code : "catalog_tool_failed";
   const retryable = typeof (cause as { retryable?: unknown })?.retryable === "boolean" && (cause as { retryable: boolean }).retryable && job.attempts < job.maxAttempts;
   await dependencies.store.transaction(async (transaction) => {
    await transaction.query("SELECT id FROM brain_jobs WHERE id=$1 AND tenant_id='local' FOR UPDATE", [job.id]);
    const active = await transaction.query<{ id: string }>("UPDATE brain_catalog_executions SET status=$4,last_error=$5,retryable=$6,updated_at=now() WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND worker_id=$3 AND status='running' AND lease_expires_at>now() RETURNING id", [initial.id, initial.brain_id, token, retryable ? "pending" : "failed", code, retryable]);
    if (active.length && activeOrdinal !== undefined) await transaction.query("UPDATE brain_catalog_execution_steps SET status='failed',error_code=$4 WHERE execution_id=$1 AND ordinal=$2 AND tenant_id='local' AND brain_id=$3 AND status<>'complete'", [initial.id, activeOrdinal, initial.brain_id, code]);
    if (!retryable && active.length) await transaction.query("UPDATE brain_jobs SET attempts=max_attempts WHERE id=$1 AND tenant_id='local' AND worker_id=$2 AND status='running'", [job.id, dependencies.workerId]);
   });
   throw cause;
  } finally {
   clearInterval(timer); await renewal;
   await dependencies.store.query("UPDATE brain_catalog_executions SET worker_id=NULL,lease_expires_at=NULL WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND worker_id=$3", [initial.id, initial.brain_id, token]);
  }
 };
}
