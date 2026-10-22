import { createHash } from "node:crypto";
import type { BrainManifestEntry, BrainSnapshot, BrainRepository } from "./repository";
import type { OperationContext } from "./operation-registry";

type ScopedSnapshot = BrainSnapshot & { tenantId?: string };
export const MEMORY_SOURCE = "manas-memory";
const prefix = "memory.";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
 if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
 if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => JSON.stringify(key) + ":" + canonical(value)).join(",") + "}";
 return JSON.stringify(value);
}
export class MemoryOperationError extends Error {
 readonly retryable: boolean;
 constructor(readonly code: string, message: string, readonly suggestedFix: string) { super(message); this.name = "MemoryOperationError"; this.retryable = code === "revision_conflict"; }
}
function fail(code: string, message: string, fix: string): never { throw new MemoryOperationError(code, message, fix); }
export interface MemoryProvenance { sourceType: string; sourceId?: string; sessionId?: string; turnId?: string; observedAt?: string; }
export interface MemoryWriteInput {
 idempotencyKey: string;
 text: string;
 provenance: MemoryProvenance;
 validFrom?: string;
 validUntil?: string;
 visibility?: string[];
}
export interface MemoryCorrectInput extends MemoryWriteInput { id: string; expectedRevision: string; }
export interface MemoryForgetInput { id: string; expectedRevision: string; idempotencyKey: string; reason?: string; }
export interface MemoryReceipt { id: string; revision: string; status: "active" | "withdrawn"; commit: string; replayed: boolean; currentStatus: "active" | "withdrawn"; currentRevision: string; }
export interface MemoryState { revision: string; status: "active" | "withdrawn"; createdAt: string; updatedAt: string; validFrom?: string; validUntil?: string; supersedes?: string; provenance: MemoryProvenance; }
export function memoryState(entry: { source?: { type: string; provenance?: { metadata?: Record<string, string> } } }): MemoryState | undefined {
 if (entry.source?.type !== MEMORY_SOURCE) return undefined;
 const values = entry.source.provenance?.metadata ?? {};
 try {
  const state = JSON.parse(values[prefix + "state"] ?? "null") as MemoryState;
  if (!state || !["active", "withdrawn"].includes(state.status) || !state.revision || !state.provenance?.sourceType || !Number.isFinite(Date.parse(state.createdAt)) || !Number.isFinite(Date.parse(state.updatedAt))) throw new Error("invalid state");
  if ([state.validFrom, state.validUntil].some((at) => at !== undefined && !Number.isFinite(Date.parse(at)))) throw new Error("invalid validity");
  return state;
 } catch { fail("invalid_memory", "Memory metadata is invalid.", "Inspect the Git record and restore a verified memory revision."); }
}
export function memoryIsActive(entry: { source?: { type: string; provenance?: { metadata?: Record<string, string> } } }, now = new Date()): boolean {
 if (entry.source?.type !== MEMORY_SOURCE) return true;
 try { const state = memoryState(entry)!; return state.status === "active" && (!state.validFrom || Date.parse(state.validFrom) <= now.getTime()) && (!state.validUntil || Date.parse(state.validUntil) > now.getTime()); }
 catch { return false; }
}
function assertScope(snapshot: ScopedSnapshot, context: OperationContext): void {
 if ((context.tenantId ?? "local") !== (snapshot.tenantId ?? "local") || context.brainId && context.brainId !== snapshot.brainId) fail("unauthorized", "Memory brain is not authorized.", "Select an authorized tenant and brain.");
}
function visible(entry: BrainManifestEntry, context: OperationContext): boolean { return context.allowedAccessLabels === undefined || (entry.accessLabels ?? []).every((label) => context.allowedAccessLabels!.includes(label)); }
function bounded(value: unknown, field: string, maximum: number): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > maximum) fail("invalid_input", field + " is required and must be bounded.", "Supply a nonempty " + field + " of at most " + maximum + " characters."); }
function date(value: string | undefined): string | undefined { if (value === undefined) return undefined; if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("invalid_input", "Invalid memory validity date.", "Supply an ISO timestamp."); return new Date(value).toISOString(); }
function validateWrite(input: MemoryWriteInput, context: OperationContext) {
 bounded(input.text, "text", 16_000);
 if (!input.provenance || typeof input.provenance !== "object" || Array.isArray(input.provenance) || Object.keys(input.provenance).some((key) => !["sourceType", "sourceId", "sessionId", "turnId", "observedAt"].includes(key))) fail("invalid_input", "Memory provenance is required.", "Supply sourceType and optional source/session/turn identifiers.");
 bounded(input.provenance.sourceType, "sourceType", 128);
 for (const value of Object.values(input.provenance)) bounded(value, "provenance value", 512);
 if (input.provenance.observedAt) date(input.provenance.observedAt);
 const validFrom = date(input.validFrom), validUntil = date(input.validUntil);
 if (validFrom && validUntil && validUntil <= validFrom) fail("invalid_input", "Memory validity must end after it begins.", "Correct validFrom or validUntil.");
 const labels = input.visibility ?? [];
 if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string" || !label.trim() || label.length > 128)) fail("invalid_input", "Invalid visibility labels.", "Supply bounded nonempty visibility labels.");
 const visibility = [...new Set(labels)].sort();
 if (context.allowedAccessLabels && visibility.some((label) => !context.allowedAccessLabels!.includes(label))) fail("unauthorized", "Memory visibility is not authorized.", "Use only granted visibility labels.");
 return { validFrom, validUntil, visibility };
}
type ReceiptData = { requestHash: string; revision: string; status: "active" | "withdrawn" };
async function currentSnapshot(repository: BrainRepository): Promise<ScopedSnapshot> {
 if (await repository.head()) return repository.snapshot();
 return { ...await repository.getIdentity(), settings: await repository.getSettings(), pages: [], commit: "" };
}
export async function writeMemory(repository: BrainRepository, context: OperationContext, action: "remember" | "correct" | "forget", input: MemoryWriteInput | MemoryCorrectInput | MemoryForgetInput): Promise<MemoryReceipt> {
 if (context.scope === "read") fail("unauthorized", "Memory writes require write scope.", "Authorize the client for memory writes.");
 bounded(input.idempotencyKey, "idempotencyKey", 256);
 const values = action === "forget" ? undefined : validateWrite(input as MemoryWriteInput, context);
 if (action !== "remember") { bounded((input as MemoryForgetInput).id, "id", 128); bounded((input as MemoryForgetInput).expectedRevision, "expectedRevision", 128); }
 if (action === "forget" && (input as MemoryForgetInput).reason !== undefined) bounded((input as MemoryForgetInput).reason, "reason", 512);
 const requestHash = hash(canonical({ action, input }));
 for (let attempt = 0; attempt < 4; attempt++) {
  const snapshot = await currentSnapshot(repository);
  assertScope(snapshot, context);
  const key = prefix + "receipt." + hash(canonical({ tenantId: context.tenantId ?? "local", brainId: snapshot.brainId, key: input.idempotencyKey }));
  for (const entry of snapshot.pages) {
   const receiptValue = entry.source?.type === MEMORY_SOURCE && entry.source.provenance?.metadata?.[key];
   if (!receiptValue) continue;
   if (!visible(entry, context)) fail("unauthorized", "Memory is unavailable.", "Use a client authorized for this memory.");
   const receipt = JSON.parse(receiptValue) as ReceiptData;
   if (receipt.requestHash !== requestHash) fail("idempotency_conflict", "Idempotency key was used for different input.", "Use a new key for a new operation.");
   return { id: entry.id, revision: receipt.revision, status: receipt.status, commit: snapshot.commit, replayed: true, currentStatus: memoryState(entry)!.status, currentRevision: memoryState(entry)!.revision };
  }
  const existing = action === "remember" ? undefined : snapshot.pages.find((entry) => entry.id === (input as MemoryForgetInput).id && !entry.deleted && entry.source?.type === MEMORY_SOURCE);
  if (action !== "remember" && (!existing || !visible(existing, context))) fail("not_found", "Memory is unavailable.", "Recall an authorized memory ID.");
  const previous = existing ? memoryState(existing)! : undefined;
  if (previous?.status === "withdrawn") fail("memory_withdrawn", "Withdrawn memories cannot be corrected or reactivated.", "Remember a new assertion with new provenance if explicitly intended.");
  if (previous && previous.revision !== (input as MemoryForgetInput).expectedRevision) fail("revision_conflict", "Memory revision changed.", "Recall the current revision and review before retrying.");
  const metadata = { ...(existing?.source?.provenance?.metadata ?? {}) };
  if (action !== "forget" && Object.keys(metadata).filter((key) => key.startsWith(prefix + "receipt.")).length >= 1_000) fail("memory_capacity", "Memory revision receipt limit reached.", "Create a new memory record; retain this record and its history.");
  const at = new Date().toISOString();
  const state: MemoryState = {
   revision: hash(canonical({ requestHash, previous: previous?.revision, at })),
   status: action === "forget" ? "withdrawn" : "active",
   createdAt: previous?.createdAt ?? at, updatedAt: at,
   ...((values?.validFrom ?? previous?.validFrom) ? { validFrom: values?.validFrom ?? previous?.validFrom } : {}),
   ...((values?.validUntil ?? previous?.validUntil) ? { validUntil: values?.validUntil ?? previous?.validUntil } : {}),
   ...(previous ? { supersedes: previous.revision } : {}),
   provenance: action === "forget" ? previous!.provenance : (input as MemoryWriteInput).provenance,
  };
  if (state.validFrom && state.validUntil && state.validUntil <= state.validFrom) fail("invalid_input", "Memory validity must end after it begins.", "Supply compatible validity dates.");
  metadata[prefix + "state"] = JSON.stringify(state);
  metadata[key] = JSON.stringify({ requestHash, revision: state.revision, status: state.status } satisfies ReceiptData);
  if (existing) metadata[prefix + "lineage." + previous!.revision] = JSON.stringify({ revision: previous!.revision, documentRevision: existing.revision, commit: snapshot.commit, supersededAt: at, action, ...((input as MemoryForgetInput).reason ? { reason: (input as MemoryForgetInput).reason } : {}) });
  const path = existing?.path ?? "notes/memories/" + key.slice((prefix + "receipt.").length) + ".md";
  const text = action === "forget" ? "This memory has been withdrawn from ordinary retrieval. Its earlier assertions remain in owner-accessible Git history.\n" : (input as MemoryWriteInput).text;
  const source = { type: MEMORY_SOURCE, externalId: existing?.source?.externalId ?? key, updatedAt: at, visibilityLabels: action === "forget" || (input as MemoryWriteInput).visibility === undefined ? existing?.accessLabels ?? [] : values!.visibility, provenance: { sourceType: MEMORY_SOURCE, retrievedAt: at, metadata } };
  try {
   const result = await repository.putPage(path, text, existing?.revision, source, snapshot.commit || undefined);
   return { id: result.id, revision: state.revision, status: state.status, commit: result.commit, replayed: false, currentStatus: state.status, currentRevision: state.revision };
  } catch (error) {
   // The commit can succeed before a receipt is returned. Re-read Git before reporting failure.
   const after = await currentSnapshot(repository);
   if (after.pages.some((entry) => entry.source?.provenance?.metadata?.[key])) continue;
   if (error instanceof Error && error.message === "stale brain repository head" && attempt < 3) continue;
   throw error;
  }
 }
 fail("revision_conflict", "Memory write could not settle against the current Git head.", "Recall the current revision and retry with the same idempotency key.");
}
export const remember = (repository: BrainRepository, context: OperationContext, input: MemoryWriteInput) => writeMemory(repository, context, "remember", input);
export const correct = (repository: BrainRepository, context: OperationContext, input: MemoryCorrectInput) => writeMemory(repository, context, "correct", input);
export const forget = (repository: BrainRepository, context: OperationContext, input: MemoryForgetInput) => writeMemory(repository, context, "forget", input);

export async function recall(repository: BrainRepository, context: OperationContext, input: { query: string; limit?: number; now?: Date }) {
 bounded(input.query, "query", 2_000);
 const limit = input.limit ?? 10;
 if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("invalid_input", "Invalid recall limit.", "Choose a limit from 1 to 100.");
 const snapshot = await currentSnapshot(repository);
 assertScope(snapshot, context);
 const tokens = [...new Set(input.query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
 if (!tokens.length) fail("invalid_input", "Recall requires search terms.", "Supply letters or numbers.");
 const results = [];
 for (const entry of snapshot.pages) {
  if (entry.deleted || entry.stale || entry.source?.type !== MEMORY_SOURCE || !visible(entry, context) || !memoryIsActive(entry, input.now)) continue;
  const page = await repository.readPage(snapshot, entry.id);
  const matches = tokens.filter((token) => page.content.toLowerCase().includes(token)).length;
  if (!matches) continue;
  results.push({ id: entry.id, text: page.content, ...memoryState(entry)!, visibility: entry.accessLabels ?? [], score: matches / tokens.length,
   citation: { tenantId: snapshot.tenantId ?? "local", brainId: snapshot.brainId, documentId: entry.id, documentRevision: entry.revision, revision: entry.revision, path: entry.path, commit: snapshot.commit, startOffset: 0, endOffset: page.content.length, contentHash: hash(page.content), chunkId: entry.id + ":" + hash(page.content) + ":0:" + page.content.length, schemaPack: snapshot.settings.schemaPack, authorizationScope: { tenantId: context.tenantId ?? "local", brainId: snapshot.brainId, allowedAccessLabels: context.allowedAccessLabels ?? null } } });
 }
 const latest = await currentSnapshot(repository);
 assertScope(latest, context);
 const current = results.filter((result) => latest.pages.some((entry) => entry.id === result.id && !entry.deleted && !entry.stale && entry.revision === result.citation.documentRevision && memoryIsActive(entry, input.now) && visible(entry, context)));
 return { results: current.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit), commit: snapshot.commit };
}
export async function memoryHistory(repository: BrainRepository, context: OperationContext, id: string, limit = 50) {
 if (context.scope !== "admin" || context.allowedAccessLabels !== undefined) fail("unauthorized", "Memory history requires explicit owner administration.", "Use owner administration to inspect withdrawn Git history.");
 const snapshot = await currentSnapshot(repository);
 assertScope(snapshot, context);
 const entry = snapshot.pages.find((entry) => entry.id === id && entry.source?.type === MEMORY_SOURCE);
 if (!entry) fail("not_found", "Memory does not exist.", "Select a known memory ID.");
 const history = [];
 for (const revision of await repository.pageHistory(entry.path, limit)) {
  const at = await repository.snapshot(revision.commit);
  const historical = at.pages.find((page) => page.id === id);
  if (historical?.source?.type !== MEMORY_SOURCE) continue;
  history.push({ ...revision, ...memoryState(historical), text: (await repository.readPage(at, id)).content, documentRevision: historical.revision });
 }
 return { id, history, forgetting: "withdrawal_from_retrieval_not_deletion_from_git_history" };
}
