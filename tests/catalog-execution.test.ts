import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createBrainEngine } from "../src/engine";
import { defaultConfig, loadConfig } from "../src/config";
import { startExecution, executionStatus, cancelExecution, catalogExecutionHandler, ExecutionError, type ExecutionStep } from "../src/brain/catalog-execution";
import { runOneJob, claimJob, cancelJob } from "../src/brain/jobs";
import { indexBrainRepository } from "../src/brain/pglite-indexer";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const owner = { scope: "admin" as const, tenantId: "local", principal: "owner" };
async function fixture(managedWrites = false) {
 const root = await mkdtemp(join(tmpdir(), "manas-execution-")); roots.push(root);
 const config = { ...defaultConfig({ MANAS_STATE: join(root, "state"), MANAS_ARCHIVE: join(root, "archive") }), automation: { managedWrites } };
 const engine = await createBrainEngine({ repositoryRoot: join(root, "brain"), storePath: join(root, "store"), config });
 execFileSync("git", ["-C", engine.repository.root, "config", "user.name", "Test"]);
 execFileSync("git", ["-C", engine.repository.root, "config", "user.email", "test@example.invalid"]);
 await engine.repository.putPage("notes/facts.md", "Maya owns Juniper. Juniper belongs to Cedar.");
 await indexBrainRepository(engine.store!, engine.repository);
 const dependencies = { store: engine.store!, repository: engine.repository, managedWrites: () => config.automation.managedWrites };
 return { root, engine, config, dependencies };
}
const search: ExecutionStep = { operation: "retrieval.search", input: { query: "Juniper", options: { mode: "hybrid" } }, maximumOutputTokens: 32768 };
test("catalog executions persist ordered results, references, input hashes, and idempotent start receipts", async () => {
 const { engine, dependencies } = await fixture();
 try {
  const steps = [search, { operation: "retrieval.get", input: { id: { $result: { step: 0, path: ["results", 0, "citation", "documentId"] } } } }];
  const started = await engine.operations.execute(owner, "execution.start", { idempotencyKey: "read", steps }) as { id: string };
  expect(await engine.operations.execute(owner, "execution.start", { steps, idempotencyKey: "read" })).toMatchObject({ id: started.id, replayed: true });
  await expect(startExecution(dependencies, owner, { idempotencyKey: "read", steps: [search] })).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(await engine.operations.execute(owner, "jobs.run-one", {})).toMatchObject({ job: { type: "catalog-execution", status: "complete" } });
  const summary = await executionStatus(dependencies, owner, { id: started.id });
  expect(summary).toMatchObject({ status: "complete", historicalResults: false, usage: { items: 2 } });
  expect(JSON.stringify(summary)).not.toContain("Maya owns");
  const history = await executionStatus(dependencies, owner, { id: started.id, includeHistoricalResults: true });
  expect(history.steps.every((step) => step.status === "complete" && step.resultHash && step.inputHash && step.attempts === 1)).toBe(true);
  expect(JSON.stringify(history)).toContain("Maya owns");
  expect((await dependencies.store.query<{ input: { options: { mode: string } } }>("SELECT input FROM brain_catalog_execution_steps WHERE execution_id=$1 AND ordinal=0", [started.id]))[0]!.input.options.mode).toBe("keyword");
  expect(await cancelExecution(dependencies, owner, started.id)).toMatchObject({ status: "complete" });
  expect((await dependencies.store.query("SELECT status FROM brain_jobs WHERE type='catalog-execution'"))[0]).toMatchObject({ status: "complete" });
 } finally { await engine.close(); }
});
test("completed steps survive a retry without executing their tools again", async () => {
 const { engine, dependencies } = await fixture();
 try {
  const started = await startExecution(dependencies, owner, { idempotencyKey: "recover", steps: [search, { operation: "entities.resolve", input: { query: "Maya" } }] });
  const calls: string[] = []; let failed = false;
  const handler = catalogExecutionHandler({ ...dependencies, workerId: "worker", execute: async (context, operation, input) => { calls.push(operation); return engine.operations.execute(context, operation, input); }, faultInjector: async (point, ordinal) => { if (point === "after-step" && ordinal === 0 && !failed) { failed = true; throw new ExecutionError("simulated_interruption", true); } } });
  await expect(runOneJob(dependencies.store, "worker", { "catalog-execution": handler })).rejects.toMatchObject({ code: "simulated_interruption" });
  expect(await executionStatus(dependencies, owner, { id: started.id })).toMatchObject({ status: "pending", usage: { items: 1 } });
  await dependencies.store.query("UPDATE brain_jobs SET available_at=now() WHERE id=$1", [started.jobId]);
  expect(await runOneJob(dependencies.store, "worker", { "catalog-execution": handler })).toMatchObject({ status: "complete" });
  expect(calls).toEqual(["retrieval.search", "entities.resolve"]);
  expect(await executionStatus(dependencies, owner, { id: started.id })).toMatchObject({ status: "complete", usage: { items: 2 } });
 } finally { await engine.close(); }
});
test("managed graph writes require opt-in, verify evidence, and recover a commit before step persistence", async () => {
 const { engine, dependencies, config } = await fixture();
 try {
  const step: ExecutionStep = { operation: "entities.put", input: { name: "Maya", entityType: "person", aliases: [], confidence: 1, evidence: { $result: { step: 0, path: ["results", 0, "citation"] } } } };
  await expect(startExecution(dependencies, owner, { idempotencyKey: "write", steps: [search, step] })).rejects.toMatchObject({ code: "managed_writes_disabled" });
  config.automation.managedWrites = true;
  const actual = { ...step, input: { ...step.input, evidence: [{ $result: { step: 0, path: ["results", 0, "citation"] } }] } };
  const started = await startExecution(dependencies, owner, { idempotencyKey: "write", steps: [search, actual] });
  let interrupted = false;
  const handler = catalogExecutionHandler({ ...dependencies, workerId: "worker", execute: (context, operation, input) => engine.operations.execute(context, operation, input), faultInjector: async (point, ordinal) => { if (point === "after-tool" && ordinal === 1 && !interrupted) { interrupted = true; throw new ExecutionError("simulated_after_commit", true); } } });
  await expect(runOneJob(dependencies.store, "worker", { "catalog-execution": handler })).rejects.toMatchObject({ code: "simulated_after_commit" });
  const head = await engine.repository.head();
  expect((await engine.repository.listPages()).filter((page) => page.source?.type === "manas-entity")).toHaveLength(1);
  await dependencies.store.query("UPDATE brain_jobs SET available_at=now() WHERE id=$1", [started.jobId]);
  expect(await runOneJob(dependencies.store, "worker", { "catalog-execution": handler })).toMatchObject({ status: "complete" });
  expect(await engine.repository.head()).toBe(head);
  expect((await executionStatus(dependencies, owner, { id: started.id })).usage.items).toBe(3);
 } finally { await engine.close(); }
});
test("budget admission, output limits, runtime cancellation, and bounded retries fail with durable codes", async () => {
 const { engine, dependencies } = await fixture();
 try {
  for (const [key, budget, step, execute, expected] of [
   ["admission", { maximumTokens: 256 }, { operation: "entities.resolve", input: { query: "Maya" }, maximumOutputTokens: 256 }, async () => ({}), "execution_budget_exhausted"],
   ["output", {}, { operation: "entities.resolve", input: { query: "Maya" }, maximumOutputTokens: 128 }, async () => ({ text: "x".repeat(256) }), "execution_output_budget_exceeded"],
   ["runtime", {}, { operation: "entities.resolve", input: { query: "Maya" }, timeoutMs: 50 }, async (context: { signal?: AbortSignal }) => { await new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => resolve(), { once: true })); return {}; }, "execution_runtime_budget_exceeded"],
  ] as const) {
   let calls = 0;
   const started = await startExecution(dependencies, owner, { idempotencyKey: key, budget, steps: [step] });
   const handler = catalogExecutionHandler({ ...dependencies, workerId: "worker", execute: async (...args) => { calls++; return execute(args[0]); } });
   await expect(runOneJob(dependencies.store, "worker", { "catalog-execution": handler })).rejects.toMatchObject({ code: expected });
   expect(await executionStatus(dependencies, owner, { id: started.id })).toMatchObject({ status: "failed", errorCode: expected, retryable: false });
   expect((await dependencies.store.query("SELECT status FROM brain_jobs WHERE id=$1", [started.jobId]))[0]).toMatchObject({ status: "failed" });
   expect(calls).toBe(key === "admission" ? 0 : 1);
  }
 } finally { await engine.close(); }
});
test("cancellation and lost leases stop subsequent tools and cannot publish late results", async () => {
 const { engine, dependencies } = await fixture();
 try {
  const started = await startExecution(dependencies, owner, { idempotencyKey: "cancel", steps: [search, search] });
  let calls = 0;
  const handler = catalogExecutionHandler({ ...dependencies, workerId: "worker", execute: async () => { calls++; await cancelExecution(dependencies, owner, started.id); return { secret: "late result" }; } });
  expect(await runOneJob(dependencies.store, "worker", { "catalog-execution": handler })).toMatchObject({ status: "cancelled" });
  expect(calls).toBe(1);
  const cancelled = await executionStatus(dependencies, owner, { id: started.id, includeHistoricalResults: true });
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.steps.every((step) => step.result === null)).toBe(true);
  const lost = await startExecution(dependencies, owner, { idempotencyKey: "lease", steps: [search] });
  const expired = catalogExecutionHandler({ ...dependencies, workerId: "worker", execute: async () => { await dependencies.store.query("UPDATE brain_catalog_executions SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [lost.id]); return { secret: "unowned" }; } });
  await expect(runOneJob(dependencies.store, "worker", { "catalog-execution": expired })).rejects.toMatchObject({ code: "execution_cancelled_or_lease_lost" });
  expect((await executionStatus(dependencies, owner, { id: lost.id, includeHistoricalResults: true })).steps[0]!.result).toBeNull();
 } finally { await engine.close(); }
});
test("execution authority and operation allowlists reject raw tools, corrections, foreign scope, and unsafe references", async () => {
 const { engine, dependencies } = await fixture(true);
 try {
  for (const operation of ["put_page", "jobs.enqueue", "memory.forget", "memory.correct", "entities.review.resolve", "execution.start", "reasoning.answer"]) await expect(startExecution(dependencies, owner, { idempotencyKey: operation, steps: [{ operation, input: {} }] })).rejects.toMatchObject({ code: "execution_operation_denied" });
  await expect(startExecution(dependencies, { ...owner, allowedAccessLabels: [] }, { idempotencyKey: "scoped", steps: [search] })).rejects.toMatchObject({ code: "owner_access_required" });
  await expect(startExecution(dependencies, { ...owner, tenantId: "other" }, { idempotencyKey: "tenant", steps: [search] })).rejects.toMatchObject({ code: "owner_access_required" });
  await expect(startExecution(dependencies, owner, { idempotencyKey: "existing", steps: [{ operation: "entities.put", input: { id: "existing" } }] })).rejects.toMatchObject({ code: "execution_write_requires_new_owned_record" });
  const started = await startExecution(dependencies, owner, { idempotencyKey: "reference", steps: [{ operation: "entities.resolve", input: { query: { $result: { step: 0, path: [] } } } }] });
  await expect(engine.operations.execute(owner, "jobs.run-one", {})).rejects.toMatchObject({ code: "invalid_result_reference" });
  expect(await executionStatus(dependencies, owner, { id: started.id })).toMatchObject({ status: "failed" });
 } finally { await engine.close(); }
});
test("managed-write settings are validated and revocation stops a queued execution", async () => {
 const { engine, dependencies, config } = await fixture(true);
 try {
  await expect(loadConfig({ environment: {}, explicit: { automation: { managedWrites: "yes" } as never } })).rejects.toThrow("boolean");
  await expect(loadConfig({ environment: {}, explicit: { automation: { unexpected: true } as never } })).rejects.toThrow("unknown");
  const started = await startExecution(dependencies, owner, { idempotencyKey: "revoked", steps: [{ operation: "entities.put", input: { name: "Maya", entityType: "person", aliases: [], confidence: 1, evidence: [] } }] });
  config.automation.managedWrites = false;
  await expect(engine.operations.execute(owner, "jobs.run-one", {})).rejects.toMatchObject({ code: "managed_writes_disabled" });
  expect(await executionStatus(dependencies, owner, { id: started.id })).toMatchObject({ status: "failed", usage: { items: 0 } });
 } finally { await engine.close(); }
});

test("executions survive a store reopen and enforce retry budgets without resetting usage", async () => {
 const { engine, dependencies, config, root } = await fixture();
 const started = await startExecution(dependencies, owner, { idempotencyKey: "restart", steps: [search] });
 await engine.close();
 const reopened = await createBrainEngine({ repositoryRoot: join(root, "brain"), storePath: join(root, "store"), config });
 try {
  expect(await reopened.operations.execute(owner, "jobs.run-one", {})).toMatchObject({ job: { status: "complete" } });
  expect(await reopened.operations.execute(owner, "execution.status", { id: started.id })).toMatchObject({ status: "complete", usage: { items: 1 } });
  const active = { store: reopened.store!, repository: reopened.repository };
  const retry = await startExecution(active, owner, { idempotencyKey: "attempts", steps: [{ operation: "entities.resolve", input: { query: "Maya" }, maximumOutputTokens: 128 }], budget: { maximumItems: 3, maximumTokens: 4096 } });
  let calls = 0;
  const handler = catalogExecutionHandler({ ...active, workerId: "retry-worker", execute: async () => { calls++; throw new ExecutionError("temporary_tool_failure", true); } });
  for (let attempt = 0; attempt < 3; attempt++) {
   await active.store.query("UPDATE brain_jobs SET available_at=now() WHERE id=$1", [retry.jobId]);
   await expect(runOneJob(active.store, "retry-worker", { "catalog-execution": handler })).rejects.toMatchObject({ code: "temporary_tool_failure" });
  }
  expect(calls).toBe(3);
  expect(await executionStatus(active, owner, { id: retry.id })).toMatchObject({ status: "failed", usage: { items: 3 }, retryable: false, steps: [{ attempts: 3 }] });
 } finally { await reopened.close(); }
});
test("longer tools renew both leases and observe cancellation through their abort signal", async () => {
 const { engine, dependencies } = await fixture();
 try {
  const started = await startExecution(dependencies, owner, { idempotencyKey: "renew", steps: [{ operation: "entities.resolve", input: { query: "Maya" } }] });
  let before = 0, after = 0;
  const handler = catalogExecutionHandler({ ...dependencies, workerId: "renew-worker", execute: async () => {
   before = new Date((await dependencies.store.query<{ lease_expires_at: string }>("SELECT lease_expires_at FROM brain_jobs WHERE id=$1", [started.jobId]))[0]!.lease_expires_at).getTime();
   await new Promise((resolve) => setTimeout(resolve, 650));
   after = new Date((await dependencies.store.query<{ lease_expires_at: string }>("SELECT lease_expires_at FROM brain_jobs WHERE id=$1", [started.jobId]))[0]!.lease_expires_at).getTime();
   return {};
  } });
  expect(await runOneJob(dependencies.store, "renew-worker", { "catalog-execution": handler })).toMatchObject({ status: "complete" });
  expect(after).toBeGreaterThan(before);
  const cancelled = await startExecution(dependencies, owner, { idempotencyKey: "abort", steps: [search] });
  let begin!: () => void; const began = new Promise<void>((resolve) => { begin = resolve; });
  let aborted = false;
  const cancelHandler = catalogExecutionHandler({ ...dependencies, workerId: "cancel-worker", execute: async (context) => {
   begin(); await new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
   return { late: "do not persist" };
  } });
  const work = runOneJob(dependencies.store, "cancel-worker", { "catalog-execution": cancelHandler });
  await began; await cancelExecution(dependencies, owner, cancelled.id);
  expect(await work).toMatchObject({ status: "cancelled" }); expect(aborted).toBe(true);
  expect((await executionStatus(dependencies, owner, { id: cancelled.id, includeHistoricalResults: true })).steps[0]!.result).toBeNull();
 } finally { await engine.close(); }
});
test("live service executes an owner catalog plan and exposes only explicit historical tool results", async () => {
 const { startLocalService, callLocalService } = await import("../src/local-service");
 const { root, config, engine } = await fixture(); await engine.close();
 const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store") });
 try {
  const started = await callLocalService(config, "execution.start", { idempotencyKey: "service", steps: [search] }) as { id: string };
  let receipt: { status: string; steps: unknown[] } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
   receipt = await callLocalService(config, "execution.status", { id: started.id }) as typeof receipt;
   if (receipt?.status === "complete" || receipt?.status === "failed") break;
   await new Promise((resolve) => setTimeout(resolve, 30));
  }
  expect(receipt).toMatchObject({ status: "complete" });
  expect(JSON.stringify(receipt)).not.toContain("Maya owns");
  expect(JSON.stringify(await callLocalService(config, "execution.status", { id: started.id, includeHistoricalResults: true }))).toContain("Maya owns");
  await expect(callLocalService(config, "execution.status", { id: started.id }, { context: { scope: "admin", allowedAccessLabels: [] } })).rejects.toMatchObject({ code: "owner_access_required" });
 } finally { await service.close(); }
}, 15000);

test("generic job cancellation and dependency cancellation atomically withdraw pending executions", async () => {
 const { engine, dependencies } = await fixture();
 try {
  const { enqueueJob, cancelJobTree } = await import("../src/brain/jobs");
  const first = await startExecution(dependencies, owner, { idempotencyKey: "job-cancel", steps: [search] });
  await cancelJob(dependencies.store, first.jobId);
  expect(await executionStatus(dependencies, owner, { id: first.id })).toMatchObject({ status: "cancelled", usage: { items: 0 } });
  const parent = await enqueueJob(dependencies.store, { type: "report", payload: {} });
  const child = await startExecution(dependencies, owner, { idempotencyKey: "tree-cancel", steps: [search] });
  await dependencies.store.query("UPDATE brain_jobs SET dependency_ids=$2::jsonb WHERE id=$1", [child.jobId, JSON.stringify([parent.id])]);
  expect(await cancelJobTree(dependencies.store, parent.id)).toBe(2);
  expect(await executionStatus(dependencies, owner, { id: child.id })).toMatchObject({ status: "cancelled" });
 } finally { await engine.close(); }
});
