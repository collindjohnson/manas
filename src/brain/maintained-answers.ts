import { verifyEvidence } from "./evidence-contract";
import { createHash, randomUUID } from "node:crypto";
import type { BrainStore } from "./store";
import type { BrainRepository } from "./repository";
import type { OperationContext } from "./operation-registry";
import { searchVerifiedHybridBrainRepository, type Citation, type HybridProjectionSearchOptions } from "./pglite-indexer";
import { generateGroundedAnswer } from "./reasoning";
import { memoryIsActive } from "./memory";
import { enqueueJob, renewJobLease, updateJobProgress, type BrainJob } from "./jobs";

export const PIN_SOURCE = "manas-pinned-question";
export class AnswerAccessError extends Error {
 readonly code = "answer_unavailable"; readonly retryable = false;
 readonly suggestedFix = "Use a current authorized answer or refresh its pinned question.";
 constructor() { super("Answer or pinned question is unavailable."); }
}
type Dependencies = { store: BrainStore; repository: BrainRepository; provider?: { generate(prompt: string): Promise<string> }; check?: () => Promise<void>; searchOptions?: Pick<HybridProjectionSearchOptions, "embeddingProvider" | "rerankerProvider"> };
type Answer = Awaited<ReturnType<typeof generateGroundedAnswer>>;
type Receipt = { answerId: string; question: string; result: Answer; createdAt: string; pinId?: string; pinRevision?: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const parse = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) : value as T;
function visible(labels: string[], context: OperationContext) { return context.allowedAccessLabels === undefined || labels.every((label) => context.allowedAccessLabels!.includes(label)); }
async function scope(repository: BrainRepository, context: OperationContext) {
 const snapshot = await repository.snapshot();
 if (context.tenantId && context.tenantId !== "local" || context.brainId && context.brainId !== snapshot.brainId) throw new AnswerAccessError();
 return { snapshot, tenantId: context.tenantId ?? "local", brainId: snapshot.brainId };
}
async function validEvidence(repository: BrainRepository, context: OperationContext, citations: Answer["citations"]) {
 const { snapshot } = await scope(repository, context);
 for (const citation of citations) {
  try { await verifyEvidence(repository, snapshot, context, citation); }
  catch { return false; }
 }
 return true;
}
// Full questions contain grammatical words absent from source assertions. Keep the
// exact search first, then fuse bounded keyword searches through the same verifier.
async function answerEvidence(dependencies: Dependencies, context: OperationContext, question: string, scoped: { brainId: string; tenantId: string }) {
 const options = { ...dependencies.searchOptions, limit: 20, brainId: scoped.brainId, tenantId: scoped.tenantId, allowedAccessLabels: context.allowedAccessLabels };
 const exact = await searchVerifiedHybridBrainRepository(dependencies.store, dependencies.repository, question, options);
 if (exact.length) return exact;
 const grammatical = new Set("who what when where why how which is are was were be been being do does did can could would should will shall may might must have has had a an the of to in on at by for from with and or its it their our my your use uses using tell me about please".split(" "));
 const words = [...new Set((question.match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((word) => word.length > 1 && !grammatical.has(word.toLowerCase())).map((word) => word.toLowerCase()))].slice(0, 8);
 const candidates = new Map<string, { hit: (typeof exact)[number]; score: number }>();
 for (const word of words) {
  context.signal?.throwIfAborted();
  const hits = await searchVerifiedHybridBrainRepository(dependencies.store, dependencies.repository, word, { ...options, embeddingProvider: undefined, rerankerProvider: undefined });
  for (const [rank, hit] of hits.entries()) {
   const prior = candidates.get(hit.citation.chunkId);
   candidates.set(hit.citation.chunkId, { hit, score: (prior?.score ?? 0) + 1 / (60 + rank + 1) });
  }
 }
 return [...candidates.values()].sort((left, right) => right.score - left.score || left.hit.citation.chunkId.localeCompare(right.hit.citation.chunkId)).slice(0, 20).map((candidate) => candidate.hit);
}
export async function createAnswer(dependencies: Dependencies, context: OperationContext, question: string, pin?: { id: string; revision: string }, stableAnswerId?: string) {
 if (!question.trim() || question.length > 2000) throw new Error("question must contain 1 to 2000 characters");
 const scoped = await scope(dependencies.repository, context);
 const results = await answerEvidence(dependencies, context, question, scoped);
 const evidence = results.map((result) => ({ text: result.verifiedText, citation: { ...result.citation, projectedCommit: result.citation.commit } }));
 let result = await generateGroundedAnswer({ question, evidence, provider: dependencies.provider, verify: async (item) => {
  if (!await validEvidence(dependencies.repository, context, [item.citation])) throw new Error("evidence changed during generation");
 } });
 if (result.citations.length && !await validEvidence(dependencies.repository, context, result.citations)) result = { outcome: "synthesis_failed", code: "grounding_failed", citations: [], confidence: 0, contradictions: [], staleEvidence: [], knowledgeGaps: ["Evidence changed during generation."] };
 await dependencies.check?.();
 if (pin && result.outcome === "synthesis_failed") throw Object.assign(new Error("Pinned answer generation failed."), { code: result.code ?? "grounding_failed", retryable: false, suggestedFix: result.suggestedFix ?? "Inspect the local model and citation validation, then request another refresh." });
 const receipt: Receipt = { answerId: stableAnswerId ?? randomUUID(), question, result, createdAt: new Date().toISOString(), ...(pin ? { pinId: pin.id, pinRevision: pin.revision } : {}) };
 await dependencies.store.query("INSERT INTO brain_answer_receipts (id,tenant_id,brain_id,principal,pin_id,pin_revision,receipt) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO NOTHING", [receipt.answerId, scoped.tenantId, scoped.brainId, context.principal ?? "anonymous", pin?.id ?? null, pin?.revision ?? null, JSON.stringify(receipt)]);
 return { ...result, question, answerId: receipt.answerId, createdAt: receipt.createdAt };
}
export async function getAnswer(dependencies: Dependencies, context: OperationContext, answerId: string) {
 const scoped = await scope(dependencies.repository, context);
 const rows = await dependencies.store.query<{ receipt: unknown; principal: string }>("SELECT receipt,principal FROM brain_answer_receipts WHERE id=$1 AND tenant_id=$2 AND brain_id=$3", [answerId, scoped.tenantId, scoped.brainId]);
 if (!rows[0]) throw new AnswerAccessError();
 const receipt = parse<Receipt>(rows[0].receipt);
 if (receipt.pinId) {
  const pin = await readPin(dependencies.repository, context, receipt.pinId);
  if (pin.revision !== receipt.pinRevision) return { answerId, freshness: "stale" as const, reason: "question_changed" };
 } else if (rows[0].principal !== (context.principal ?? "anonymous") && context.scope !== "admin") throw new AnswerAccessError();
 let evidenceValid = false;
 try { evidenceValid = await validEvidence(dependencies.repository, context, receipt.result.citations); } catch { /* Missing immutable history invalidates the cached result. */ }
 const fresh = Date.now() - Date.parse(receipt.createdAt) < 3600000 && evidenceValid;
 if (!fresh) return { answerId, freshness: "stale" as const, reason: "evidence_changed_expired_or_inaccessible" };
 return { answerId, question: receipt.question, createdAt: receipt.createdAt, freshness: "current" as const, ...receipt.result };
}
type PinDefinition = { version: 1; question: string; visibility: string[]; idempotencyKey: string; requestHash: string };
function key(value: string) { if (!value.trim() || value.length > 256) throw new Error("idempotency key must contain 1 to 256 characters"); return value; }
export async function readPin(repository: BrainRepository, context: OperationContext, id: string) {
 const { snapshot } = await scope(repository, context);
 const page = snapshot.pages.find((page) => page.id === id && !page.deleted && page.source?.type === PIN_SOURCE);
 if (!page || !visible(page.accessLabels ?? [], context)) throw new AnswerAccessError();
 const definition = JSON.parse((await repository.readPage(snapshot, page.id)).content) as PinDefinition;
 if (definition.version !== 1 || typeof definition.question !== "string" || !Array.isArray(definition.visibility)) throw new Error("invalid pinned question");
 return { ...definition, visibility: page.accessLabels ?? [], id: page.id, revision: page.revision };
}
export async function definePin(dependencies: Dependencies, context: OperationContext, input: { question: string; visibility?: string[]; idempotencyKey: string; id?: string; expectedRevision?: string }) {
 const { snapshot } = await scope(dependencies.repository, context);
 key(input.idempotencyKey);
 if (!input.question.trim() || input.question.length > 2000) throw new Error("question must contain 1 to 2000 characters");
 const labels = input.visibility ?? [];
 if (!Array.isArray(labels) || labels.length > 32 || labels.some((label) => typeof label !== "string" || !label.trim() || label.length > 128) || !visible(labels, context)) throw new AnswerAccessError();
 const requestHash = hash(JSON.stringify({ question: input.question, visibility: labels, id: input.id ?? null, expectedRevision: input.expectedRevision ?? null }));
 for (const page of snapshot.pages.filter((page) => page.source?.type === PIN_SOURCE && !page.deleted)) {
  const definition = JSON.parse((await dependencies.repository.readPage(snapshot, page.id)).content) as PinDefinition;
  if (definition.idempotencyKey !== input.idempotencyKey) continue;
  if (!visible(page.accessLabels ?? [], context) || definition.requestHash !== requestHash) throw new Error("pinned-question idempotency conflict");
  return { id: page.id, revision: page.revision, replayed: true };
 }
 const existing = input.id ? await readPin(dependencies.repository, context, input.id) : undefined;
 if (existing && existing.revision !== input.expectedRevision || !existing && input.expectedRevision) throw new Error("stale pinned question revision");
 const path = existing ? snapshot.pages.find((page) => page.id === existing.id)!.path : "notes/questions/" + hash(input.idempotencyKey) + ".md";
 const result = await dependencies.repository.putPage(path, JSON.stringify({ version: 1, question: input.question, visibility: labels, idempotencyKey: input.idempotencyKey, requestHash } satisfies PinDefinition) + "\n", existing?.revision, { type: PIN_SOURCE, externalId: existing?.id ?? hash(input.idempotencyKey), visibilityLabels: labels }, snapshot.commit);
 return { id: result.id, revision: result.revision, replayed: false };
}
export async function pinStatus(dependencies: Dependencies, context: OperationContext, id: string) {
 const pin = await readPin(dependencies.repository, context, id);
 const { tenantId, brainId } = await scope(dependencies.repository, context);
 const rows = await dependencies.store.query<{ id: string }>("SELECT id FROM brain_answer_receipts WHERE tenant_id=$1 AND brain_id=$2 AND pin_id=$3 AND pin_revision=$4 ORDER BY created_at DESC,id DESC LIMIT 1", [tenantId, brainId, id, pin.revision]);
 return { id, revision: pin.revision, question: pin.question, visibility: pin.visibility, answer: rows[0] ? await getAnswer(dependencies, context, rows[0].id) : { freshness: "missing" } };
}
export async function enqueuePinRefresh(dependencies: Dependencies, context: OperationContext, id: string) {
 const pin = await readPin(dependencies.repository, context, id);
 const { tenantId, brainId } = await scope(dependencies.repository, context);
 const job = await enqueueJob(dependencies.store, { tenantId, type: "pinned-answer-refresh", payload: { id, revision: pin.revision, brainId }, idempotencyKey: "pin-refresh:" + id + ":" + pin.revision + ":" + Math.floor(Date.now() / 60000) });
 return { jobId: job.id, status: job.status };
}
export function pinnedAnswerHandler(dependencies: Dependencies & { workerId: string }) {
 return async (job: BrainJob) => {
  const input = job.payload as { id: string; revision: string; brainId: string };
  if (!input || [input.id, input.revision, input.brainId].some((value) => typeof value !== "string" || !value.trim() || value.length > 256)) throw new AnswerAccessError();
  const context: OperationContext = { scope: "read", tenantId: job.tenantId, brainId: input.brainId, principal: "pinned-worker" };
  const pin = await readPin(dependencies.repository, context, input.id);
  if (pin.revision !== input.revision) throw new Error("pinned question changed before refresh");
  context.allowedAccessLabels = pin.visibility;
  const check = async () => {
   await renewJobLease(dependencies.store, job.id, dependencies.workerId, 60000, new Date(), job.tenantId);
   if ((await readPin(dependencies.repository, context, input.id)).revision !== pin.revision) throw new Error("pinned question changed during refresh");
  };
  let renewalFailure: unknown;
  const timer = setInterval(() => { void check().catch((error) => { renewalFailure = error; }); }, 10000);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
   await check();
   const stableAnswerId = hash("pinned-job:" + job.id);
   const prior = await dependencies.store.query<{ id: string }>("SELECT id FROM brain_answer_receipts WHERE id=$1 AND tenant_id=$2 AND brain_id=$3", [stableAnswerId, job.tenantId, input.brainId]);
   if (prior.length) { await updateJobProgress(dependencies.store, job.id, dependencies.workerId, { answerId: stableAnswerId, pinId: pin.id, pinRevision: pin.revision }, job.tenantId); return { answerId: stableAnswerId, replayed: true }; }
   const provider = dependencies.provider ? { generate: (prompt: string) => Promise.race([dependencies.provider!.generate(prompt), new Promise<string>((_, reject) => { deadline = setTimeout(() => reject(new Error("local answer generation timed out")), 45000); })]) } : undefined;
   const answer = await createAnswer({ ...dependencies, provider, check: async () => { if (renewalFailure) throw renewalFailure; await check(); } }, context, pin.question, pin, stableAnswerId);
   await check();
   await updateJobProgress(dependencies.store, job.id, dependencies.workerId, { answerId: answer.answerId, pinId: pin.id, pinRevision: pin.revision, outcome: answer.outcome }, job.tenantId);
   return { answerId: answer.answerId, outcome: answer.outcome };
  } finally { clearInterval(timer); if (deadline) clearTimeout(deadline); }
 };
}
export async function answerFeedback(dependencies: Dependencies, context: OperationContext, input: { answerId: string; idempotencyKey: string; rating: number }) {
 key(input.idempotencyKey);
 if (!Number.isInteger(input.rating) || input.rating < -1 || input.rating > 1) throw new Error("rating must be -1, 0, or 1");
 const answer = await getAnswer(dependencies, context, input.answerId);
 if (answer.freshness !== "current" || answer.outcome !== "answered") throw new AnswerAccessError();
 const { tenantId, brainId } = await scope(dependencies.repository, context);
 const principal = context.principal ?? "anonymous";
 const id = hash(JSON.stringify([tenantId, brainId, principal, input.idempotencyKey]));
 await dependencies.store.query("INSERT INTO brain_answer_feedback (id,tenant_id,brain_id,principal,answer_id,rating,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING", [id, tenantId, brainId, principal, input.answerId, input.rating, JSON.stringify(answer.citations)]);
 const rows = await dependencies.store.query<{ id: string; answer_id: string; rating: number }>("SELECT id,answer_id,rating FROM brain_answer_feedback WHERE (id=$1 OR answer_id=$5) AND tenant_id=$2 AND brain_id=$3 AND principal=$4", [id, tenantId, brainId, principal, input.answerId]);
 if (rows.length !== 1 || !rows[0] || rows[0].answer_id !== input.answerId || rows[0].rating !== input.rating) throw new Error("feedback idempotency conflict");
 return { id: rows[0].id, answerId: input.answerId, rating: input.rating, rankingInfluence: false };
}
export async function resetAnswerFeedback(dependencies: Dependencies, context: OperationContext, answerId: string) {
 const { tenantId, brainId } = await scope(dependencies.repository, context);
 await dependencies.store.query("DELETE FROM brain_answer_feedback WHERE tenant_id=$1 AND brain_id=$2 AND principal=$3 AND answer_id=$4", [tenantId, brainId, context.principal ?? "anonymous", answerId]);
 return { reset: true, rankingInfluence: false };
}
