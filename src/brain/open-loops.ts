import { createHash } from "node:crypto";
import type { BrainRepository, BrainSnapshot, BrainManifestEntry } from "./repository";
import type { OperationContext } from "./operation-registry";
import type { Citation } from "./pglite-indexer";
import { recordVisible, scopedSnapshot, verifyEvidence } from "./evidence-contract";
export const OPEN_LOOP_SOURCE = "manas-open-loop";
export type LoopStatus = "open" | "done" | "cancelled";
type Receipt = { key: string; requestHash: string; status: LoopStatus };
export type LoopDefinition = { version: 1; title: string; participants: string[]; dueAt?: string; status: LoopStatus; evidence: Citation[]; createdAt: string; updatedAt: string; receipts: Receipt[] };
export type LoopWriteInput = { id?: string; expectedRevision?: string; idempotencyKey: string; title: string; participants?: string[]; dueAt?: string; evidence: Citation[]; visibility?: string[] };
export class OpenLoopError extends Error {
 readonly retryable = false;
 constructor(readonly code: string, message: string, readonly suggestedFix = "Read the current authorized loop and evidence, then retry with its revision and a new idempotency key.") { super(message); }
}
function canonical(value: unknown): string {
 if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
 if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
 return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const normalize = (text: string) => text.normalize("NFKC").trim().toLocaleLowerCase("en-US");
function bounded(value: unknown, maximum: number): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new OpenLoopError("invalid_loop_input", "Loop text is missing or exceeds its size budget."); }
function labelsVisible(labels: string[], context: OperationContext) { return context.allowedAccessLabels === undefined || labels.every((label) => context.allowedAccessLabels!.includes(label)); }
function loopPages(snapshot: BrainSnapshot) {
 const pages = snapshot.pages.filter((page) => !page.deleted && page.source?.type === OPEN_LOOP_SOURCE);
 if (pages.length > 2000) throw new OpenLoopError("loop_budget_exceeded", "Open-loop scan exceeds its 2000 record budget.");
 return pages;
}
export async function readLoopDefinition(repository: BrainRepository, snapshot: BrainSnapshot, page: BrainManifestEntry): Promise<LoopDefinition> {
 const content = (await repository.readPage(snapshot, page.id)).content;
 if (Buffer.byteLength(content) > 262144) throw new OpenLoopError("invalid_loop_record", "Loop record exceeds its size budget.");
 const value = JSON.parse(content) as LoopDefinition;
 if (value.version !== 1 || !["open", "done", "cancelled"].includes(value.status) || !Array.isArray(value.participants) || value.participants.length > 32 || !Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 10 || !Array.isArray(value.receipts) || value.receipts.length > 512) throw new OpenLoopError("invalid_loop_record", "Loop record is malformed.");
 bounded(value.title, 500); value.participants.forEach((item) => bounded(item, 128));
 return value;
}
async function verified(repository: BrainRepository, snapshot: BrainSnapshot, context: OperationContext, evidence: Citation[]) {
 if (!Array.isArray(evidence) || !evidence.length || evidence.length > 10) throw new OpenLoopError("invalid_loop_evidence", "Loops need one to ten current source citations.");
 const checked = [];
 for (const citation of evidence) checked.push(await verifyEvidence(repository, snapshot, context, citation));
 return checked;
}
export async function getOpenLoop(repository: BrainRepository, context: OperationContext, id: string) {
 const snapshot = await scopedSnapshot(repository, context);
 const page = loopPages(snapshot).find((page) => page.id === id && recordVisible(page, context));
 if (!page) throw new OpenLoopError("loop_unavailable", "Open loop is unavailable.");
 const value = await readLoopDefinition(repository, snapshot, page);
 let evidence;
 try { evidence = await verified(repository, snapshot, context, value.evidence); }
 catch { throw new OpenLoopError("loop_unavailable", "Open-loop evidence changed, expired, was withdrawn, or is inaccessible."); }
 return { id: page.id, revision: page.revision, title: value.title, participants: value.participants, status: value.status, dueAt: value.dueAt ?? null, visibility: page.accessLabels ?? [], evidence: evidence.map((item) => ({ text: item.text, citation: item.citation })), createdAt: value.createdAt, updatedAt: value.updatedAt };
}
export async function listOpenLoops(repository: BrainRepository, context: OperationContext, input: { status?: LoopStatus; participant?: string; limit?: number; after?: string; includeStale?: boolean } = {}) {
 const limit = input.limit ?? 50;
 if (!Number.isInteger(limit) || limit < 1 || limit > 100 || input.status !== undefined && !["open", "done", "cancelled"].includes(input.status)) throw new OpenLoopError("invalid_loop_input", "Invalid loop list filter.");
 if (input.includeStale && (context.scope !== "admin" || context.allowedAccessLabels !== undefined)) throw new OpenLoopError("owner_access_required", "Stale loop metadata requires owner administration.");
 const snapshot = await scopedSnapshot(repository, context);
 const pages = loopPages(snapshot).filter((page) => (!input.after || page.id > input.after) && recordVisible(page, context)).sort((a, b) => a.id.localeCompare(b.id));
 const items = [];
 let last: string | null = null, examined = 0;
 for (const page of pages) {
  last = page.id; examined++;
  const definition = await readLoopDefinition(repository, snapshot, page);
  if (input.status && definition.status !== input.status || input.participant && !definition.participants.some((participant) => normalize(participant) === normalize(input.participant!))) continue;
  try { items.push({ ...await getOpenLoop(repository, context, page.id), freshness: "current" as const }); }
  catch (error) {
   if (!(error instanceof OpenLoopError) || error.code !== "loop_unavailable") throw error;
   if (input.includeStale) items.push({ id: page.id, revision: page.revision, status: definition.status, freshness: "stale" as const });
  }
  if (items.length === limit) break;
 }
 return { items, next: examined < pages.length ? last : null };
}
async function replay(repository: BrainRepository, snapshot: BrainSnapshot, context: OperationContext, key: string, requestHash: string) {
 for (const page of loopPages(snapshot)) {
  const value = await readLoopDefinition(repository, snapshot, page);
  const receipt = value.receipts.find((receipt) => receipt.key === key);
  if (!receipt) continue;
  if (!recordVisible(page, context)) throw new OpenLoopError("loop_unavailable", "Open loop is unavailable.");
  if (receipt.requestHash !== requestHash) throw new OpenLoopError("idempotency_conflict", "The idempotency key belongs to another loop operation.");
  return { id: page.id, revision: page.revision, currentRevision: page.revision, status: value.status, currentStatus: value.status, originalStatus: receipt.status, writeId: hash([key, requestHash]), replayed: true };
 }
}
async function write(repository: BrainRepository, snapshot: BrainSnapshot, page: BrainManifestEntry | undefined, value: LoopDefinition, labels: string[], key: string, requestHash: string) {
 if (value.receipts.length >= 512 || value.receipts.length >= 511 && value.status === "open") throw new OpenLoopError("loop_receipt_capacity", "This loop has reached its operation receipt capacity; closing capacity is reserved.");
 const receipt = { key, requestHash, status: value.status };
 value.receipts.push(receipt);
 const path = page?.path ?? "notes/open-loops/" + hash(key) + ".md";
 if (Buffer.byteLength(JSON.stringify(value)) > 262144) throw new OpenLoopError("loop_budget_exceeded", "Loop record exceeds its size budget.");
 const result = await repository.putPage(path, JSON.stringify(value) + "\n", page?.revision, { type: OPEN_LOOP_SOURCE, externalId: page?.source?.externalId ?? hash(key), visibilityLabels: labels }, snapshot.commit);
 return { id: result.id, revision: result.revision, currentRevision: result.revision, status: value.status, currentStatus: value.status, writeId: hash([key, requestHash]), replayed: false };
}
export async function putOpenLoop(repository: BrainRepository, context: OperationContext, input: LoopWriteInput) {
 if (!["write", "admin"].includes(context.scope)) throw new OpenLoopError("insufficient_scope", "Loop writes require write authority.");
 bounded(input.idempotencyKey, 256); bounded(input.title, 500);
 if (input.participants !== undefined && !Array.isArray(input.participants)) throw new OpenLoopError("invalid_loop_input", "Participants must be an array.");
 if (input.dueAt !== undefined && (typeof input.dueAt !== "string" || !Number.isFinite(Date.parse(input.dueAt)))) throw new OpenLoopError("invalid_loop_input", "Loop dueAt must be an ISO timestamp.");
 const participants = [...new Set(input.participants ?? [])].sort();
 if (participants.length > 32) throw new OpenLoopError("invalid_loop_input", "A loop can have at most 32 participants.");
 participants.forEach((participant) => bounded(participant, 128));
 const dueAt = input.dueAt === undefined ? undefined : new Date(input.dueAt).toISOString();
 const snapshot = await scopedSnapshot(repository, context);
 const requestHash = hash({ operation: "put", principal: context.principal ?? "anonymous", input: { ...input, participants, dueAt } });
 const previous = await replay(repository, snapshot, context, input.idempotencyKey, requestHash);
 if (previous) return previous;
 const page = input.id ? loopPages(snapshot).find((page) => page.id === input.id && recordVisible(page, context)) : undefined;
 if (input.id && !page) throw new OpenLoopError("loop_unavailable", "Open loop is unavailable.");
 if (page && page.revision !== input.expectedRevision || !page && input.expectedRevision !== undefined) throw new OpenLoopError("revision_conflict", "Open loop changed.");
 const existing = page ? await readLoopDefinition(repository, snapshot, page) : undefined;
 const checked = await verified(repository, snapshot, context, input.evidence);
 const explicit = input.visibility ?? [];
 if (!Array.isArray(explicit) || explicit.length > 32 || explicit.some((label) => typeof label !== "string" || !label.trim() || label.length > 128)) throw new OpenLoopError("invalid_loop_input", "Invalid loop visibility.");
 const labels = [...new Set([...checked.flatMap((item) => item.labels), ...(page?.accessLabels ?? []), ...explicit])].sort();
 if (!labelsVisible(labels, context)) throw new OpenLoopError("loop_unavailable", "Loop visibility exceeds this client's authorization.");
 const now = new Date().toISOString();
 return write(repository, snapshot, page, { version: 1, title: input.title.trim(), participants, ...(dueAt ? { dueAt } : {}), status: existing?.status ?? "open", evidence: checked.map((item) => item.citation), createdAt: existing?.createdAt ?? now, updatedAt: now, receipts: existing?.receipts ?? [] }, labels, input.idempotencyKey, requestHash);
}
export async function setOpenLoopStatus(repository: BrainRepository, context: OperationContext, input: { id: string; expectedRevision: string; status: LoopStatus; idempotencyKey: string }) {
 if (!["write", "admin"].includes(context.scope)) throw new OpenLoopError("insufficient_scope", "Loop status changes require write authority.");
 bounded(input.idempotencyKey, 256);
 if (!["open", "done", "cancelled"].includes(input.status)) throw new OpenLoopError("invalid_loop_input", "Invalid open-loop status.");
 const snapshot = await scopedSnapshot(repository, context);
 const requestHash = hash({ operation: "status", principal: context.principal ?? "anonymous", input });
 const previous = await replay(repository, snapshot, context, input.idempotencyKey, requestHash);
 if (previous) return previous;
 const page = loopPages(snapshot).find((page) => page.id === input.id && recordVisible(page, context));
 if (!page) throw new OpenLoopError("loop_unavailable", "Open loop is unavailable.");
 if (page.revision !== input.expectedRevision) throw new OpenLoopError("revision_conflict", "Open loop changed.");
 const value = await readLoopDefinition(repository, snapshot, page);
 if (input.status === "open") await verified(repository, snapshot, context, value.evidence);
 return write(repository, snapshot, page, { ...value, status: input.status, updatedAt: new Date().toISOString() }, page.accessLabels ?? [], input.idempotencyKey, requestHash);
}
