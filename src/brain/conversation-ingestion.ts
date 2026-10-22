import { createHash } from "node:crypto";
import { parseFrontmatter, renderNewDocument } from "../archive";
import type { Conversation } from "../model";
import { transcriptBody, uuidv5 } from "../utils";
import type { BrainRepository, BrainSourceRecord } from "./repository";
import type { BrainStore } from "./store";
import type { OperationContext } from "./operation-registry";
import { indexBrainRepository } from "./pglite-indexer";

const start = "<!-- manas:conversation:start -->";
const end = "<!-- manas:conversation:end -->";
const sourceType = "manas-conversation";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type LegacyIdentity = { contentHash: string; provider?: string; sourceId?: string };
const legacyIdentityCaches = new WeakMap<BrainRepository, Map<string, LegacyIdentity>>();
const legacyIdentityBuilds = new WeakMap<BrainRepository, Promise<void>>();
async function legacyIdentities(repository: BrainRepository, snapshot: Awaited<ReturnType<BrainRepository["snapshot"]>>, signal?: AbortSignal): Promise<Map<string, LegacyIdentity>> {
 const previous = legacyIdentityBuilds.get(repository) ?? Promise.resolve();
 let release!: () => void;
 const gate = new Promise<void>((resolve) => { release = resolve; });
 const pending = previous.then(() => gate);
 legacyIdentityBuilds.set(repository, pending);
 await previous;
 try {
  signal?.throwIfAborted();
  let cache = legacyIdentityCaches.get(repository);
  if (!cache) { cache = new Map(); legacyIdentityCaches.set(repository, cache); }
  const entries = snapshot.pages.filter((page) => page.source?.type === "legacy-archive");
  const present = new Set(entries.map((page) => page.id));
  for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
  const missing = entries.filter((page) => cache!.get(page.id)?.contentHash !== page.contentHash);
  let next = 0;
  let failed: unknown;
  await Promise.all(Array.from({ length: Math.min(8, missing.length) }, async () => {
   while (next < missing.length && !failed) {
    const page = missing[next++]!;
    try {
     signal?.throwIfAborted();
     const parsed = parseFrontmatter((await repository.readPage(snapshot, page.id)).content);
     signal?.throwIfAborted();
     cache!.set(page.id, { contentHash: page.contentHash, provider: typeof parsed?.values.provider === "string" ? parsed.values.provider : undefined, sourceId: typeof parsed?.values.source_id === "string" ? parsed.values.source_id : undefined });
    } catch (error) { failed = error; }
   }
  }));
  if (failed) throw failed;
  return new Map(entries.map((page) => [page.id, cache!.get(page.id)!]));
 } finally { release(); if (legacyIdentityBuilds.get(repository) === pending) legacyIdentityBuilds.delete(repository); }
}

function failure(code: string, message: string, suggestedFix: string, retryable = false): Error {
 return Object.assign(new Error(message), { code, retryable, suggestedFix });
}
function conversationInput(value: unknown): Conversation {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("invalid_conversation", "Conversation must be an object.", "Use a supported local session adapter or consumer export.");
 const record = value as Record<string, unknown>;
 if (!["claude_code", "codex", "pi", "cursor", "grok", "chatgpt", "claude"].includes(String(record.provider))) throw failure("invalid_conversation", "Conversation provider is unsupported.", "Use a supported provider.");
 for (const field of ["sourceId", "sourcePath", "title", "fingerprint"]) if (typeof record[field] !== "string" || !(record[field] as string).trim() || (record[field] as string).length > 16384) throw failure("invalid_conversation", "Conversation identity or metadata is invalid.", "Check the session adapter output.");
 for (const field of ["createdAt", "updatedAt", "workspacePath", "project", "repository", "repositoryUrl", "repoKey"]) if (record[field] !== undefined && (typeof record[field] !== "string" || (record[field] as string).length > 16384)) throw failure("invalid_conversation", "Conversation metadata is invalid.", "Check the session adapter output.");
 if (!Number.isInteger(record.redactions) || Number(record.redactions) < 0 || !Array.isArray(record.messages) || record.messages.length > 100000) throw failure("invalid_conversation", "Conversation messages are invalid.", "Check the session adapter output.");
 const messages = record.messages.map((message) => {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw failure("invalid_conversation", "Conversation message is invalid.", "Check the session adapter output.");
  const item = message as Record<string, unknown>;
  if (!["user", "assistant"].includes(String(item.role)) || typeof item.text !== "string" || item.text.includes(start) || item.text.includes(end) || item.timestamp !== undefined && typeof item.timestamp !== "string") throw failure("invalid_conversation", "Conversation message or reserved marker is invalid.", "Check the session adapter output.");
  return { role: item.role as "user" | "assistant", text: item.text, ...(item.timestamp !== undefined ? { timestamp: item.timestamp as string } : {}) };
 });
 const result = Object.fromEntries(["provider", "sourceId", "sourcePath", "title", "fingerprint", "redactions", "createdAt", "updatedAt", "workspacePath", "project", "repository", "repositoryUrl", "repoKey"].filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
 return { ...result, messages } as unknown as Conversation;
}
type Intent = { version: 1; inputHash: string; documentId: string; path: string; expectedRevision?: string; previousIngestionHash?: string; expectedHead: string; action: "create" | "update" | "skip" };
export type ConversationIngestionResult = { action: "create" | "update" | "skip"; documentId: string; path: string; replayed: boolean; preservedLegacyContent: boolean; commit: string };
async function ingestConversationAttempt(dependencies: { repository: BrainRepository; store: BrainStore }, context: OperationContext, input: { conversation: unknown; dryRun?: boolean }): Promise<ConversationIngestionResult> {
 if (context.scope !== "admin" || context.allowedAccessLabels !== undefined) throw failure("owner_access_required", "Session ingestion requires unrestricted owner administration.", "Run sync or import as the local owner.");
 context.signal?.throwIfAborted();
 const conversation = conversationInput(input.conversation);
 const payload = JSON.stringify(conversation);
 if (Buffer.byteLength(payload) > 6 * 1024 * 1024) throw failure("conversation_too_large", "Conversation exceeds the six MiB ingestion limit.", "Split the source conversation before importing.");
 const { repository, store } = dependencies;
 const snapshot = await repository.snapshot();
 if (context.tenantId && context.tenantId !== "local" || context.brainId && context.brainId !== snapshot.brainId) throw failure("unauthorized", "Conversation ingestion is outside the authorized brain.", "Select the authorized brain.");
 const inputHash = hash(payload);
 const stableId = uuidv5(conversation.provider + ":" + conversation.sourceId);
 const sourceId = conversation.provider + ":" + conversation.sourceId;
 const runId = uuidv5("conversation-ingestion:" + snapshot.brainId + ":" + sourceId + ":" + inputHash);
 const rows = await store.query<{ status: string; checkpoint: Intent & { result?: ConversationIngestionResult } }>("SELECT status, checkpoint FROM brain_ingestion_runs WHERE id = $1 AND tenant_id = $2 AND brain_id = $3", [runId, "local", snapshot.brainId]);
 if (rows[0]?.status === "complete" && rows[0].checkpoint.result) return { ...rows[0].checkpoint.result, replayed: true };
 const identities = await legacyIdentities(repository, snapshot, context.signal);
 context.signal?.throwIfAborted();
 const candidates = [];
 for (const entry of snapshot.pages) {
  if (entry.source?.type === sourceType && entry.source.externalId === sourceId || entry.id === stableId) candidates.push(entry);
  else if (entry.source?.type === "legacy-archive") {
   const identity = identities.get(entry.id);
   if (identity?.provider === conversation.provider && identity.sourceId === conversation.sourceId) candidates.push(entry);
  }
 }
 if (candidates.length > 1) throw failure("conversation_identity_conflict", "Multiple canonical records identify this conversation.", "Review duplicate IDs before syncing.");
 const existing = candidates[0];
 if (existing?.deleted || existing && ![sourceType, "legacy-archive"].includes(existing.source?.type ?? "")) throw failure("conversation_identity_conflict", "The conversation ID is withdrawn or belongs to another record.", "Review the canonical record before importing.");
 const current = existing ? await repository.readPage(snapshot, existing.id) : undefined;
 const rendered = renderNewDocument(conversation);
 const body = transcriptBody(conversation.messages).trimEnd();
 const parsed = current ? parseFrontmatter(current.content) : undefined;
 if (existing?.source?.type === "legacy-archive" && (parsed?.values.provider !== conversation.provider || parsed?.values.source_id !== conversation.sourceId)) throw failure("conversation_identity_conflict", "The legacy record identity differs from the incoming session.", "Review its frontmatter before syncing.");
 const alreadyCurrent = existing?.source?.type === sourceType ? existing.source.extractionMetadata?.ingestionHash === inputHash : parsed?.values.sync_fingerprint === conversation.fingerprint && parsed.body.trim() === body.trim();
 const action = !existing ? "create" as const : alreadyCurrent ? "skip" as const : "update" as const;
 const intent: Intent = rows[0]?.checkpoint ?? { version: 1, inputHash, documentId: existing?.id ?? stableId, path: existing?.path ?? rendered.relativePath, expectedRevision: existing?.revision, previousIngestionHash: existing?.source?.extractionMetadata?.ingestionHash, expectedHead: snapshot.commit, action };
 if (intent.version !== 1 || intent.inputHash !== inputHash || intent.documentId !== (existing?.id ?? stableId) || intent.path !== (existing?.path ?? rendered.relativePath)) throw failure("conversation_recovery_conflict", "The pending ingestion no longer matches the canonical record.", "Review the source failure and retry the current conversation.");
 const applied = existing?.source?.type === sourceType && existing.source.extractionMetadata?.ingestionHash === inputHash;
 if (rows[0] && !applied && existing?.revision !== intent.expectedRevision && (!existing || existing.source?.type !== sourceType || existing.source.extractionMetadata?.ingestionHash !== intent.previousIngestionHash)) throw failure("conversation_revision_conflict", "The brain changed after this ingestion was staged.", "Rescan the current source and review the pending ingestion.");
 let content = rendered.content;
 let preservedLegacyContent = false;
 if (current && !alreadyCurrent) {
  const first = current.content.indexOf(start), last = current.content.indexOf(end);
  if (existing?.source?.type === sourceType) {
   if (first < 0 || last < first || current.content.indexOf(start, first + start.length) >= 0 || current.content.indexOf(end, last + end.length) >= 0 || hash(current.content.slice(first + start.length, last).trim()) !== existing.source.contentHash) throw failure("conversation_user_edit_conflict", "The managed transcript was edited; ingestion preserved the current file.", "Move personal edits into Notes, restore the managed transcript, and rescan.");
   content = current.content.slice(0, first) + start + "\n" + body + "\n" + end + current.content.slice(last + end.length);
  } else {
   if (!parsed) throw failure("conversation_identity_conflict", "The migrated transcript has malformed frontmatter.", "Repair its frontmatter before syncing.");
   content = parsed.header + "\n\n" + start + "\n" + body + "\n" + end + "\n\n## Preserved pre-migration content\n\n" + parsed.body;
   preservedLegacyContent = true;
  }
 } else if (!current) {
  const fresh = parseFrontmatter(rendered.content)!;
  content = fresh.header + "\n\n" + start + "\n" + body + "\n" + end + "\n\n## Notes\n";
 }
 if (input.dryRun) return { action, documentId: intent.documentId, path: intent.path, replayed: false, preservedLegacyContent, commit: snapshot.commit };
 context.signal?.throwIfAborted();
 if (!rows[0]) await store.query("INSERT INTO brain_ingestion_runs (id, tenant_id, brain_id, source_id, status, checkpoint) VALUES ($1, 'local', $2, $3, 'running', $4::jsonb) ON CONFLICT (id) DO NOTHING", [runId, snapshot.brainId, "conversation:" + sourceId, JSON.stringify(intent)]);
 // Role boundaries come from structured adapter messages, never parsed labels.
 const turns: Array<{ start: number; end: number }> = [];
 let offset = 0;
 for (const message of conversation.messages) {
  const first = offset + message.role.length + 2;
  const last = Math.min(first + message.text.length, body.length);
  if (message.role === "user" && last > first && body.slice(first, last).trim()) turns.push({ start: first, end: last });
  offset += message.role.length + 2 + message.text.length + 2;
 }
 const userTurnMap = JSON.stringify({ version: 1, transcriptHash: hash(body), turns });
 const source: BrainSourceRecord = { type: sourceType, externalId: sourceId, contentHash: hash(body.trim()), externalRevision: conversation.updatedAt, updatedAt: conversation.updatedAt, visibilityLabels: existing?.accessLabels, provenance: { sourceType: "conversation:" + conversation.provider, sourcePath: conversation.sourcePath, retrievedAt: new Date().toISOString(), metadata: Object.fromEntries(Object.entries({ provider: conversation.provider, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, project: conversation.project, repository: conversation.repository }).filter((entry): entry is [string, string] => entry[1] !== undefined)) }, extractionMetadata: { ingestionHash: inputHash, runId, userTurnMap } };
 if (!alreadyCurrent && !applied) {
  try { await repository.putPage(intent.path, content, existing?.revision, source, snapshot.commit, existing ? undefined : stableId); }
  catch (error) {
   if (error instanceof Error && /stale brain (page revision|repository head)/.test(error.message)) throw failure("conversation_revision_conflict", "The brain changed during ingestion.", "Retry sync against the current canonical brain.", true);
   throw error;
  }
 }
 context.signal?.throwIfAborted();
 // A crash after Git commit is recoverable from the source ingestion hash. Never
 // advance the durable receipt until the projection has caught up with Git.
 await indexBrainRepository(store, repository);
 const result: ConversationIngestionResult = { action: intent.action, documentId: intent.documentId, path: intent.path, replayed: Boolean(rows[0]), preservedLegacyContent, commit: (await repository.head())! };
 await store.query("UPDATE brain_ingestion_runs SET status = 'complete', checkpoint = $2::jsonb, completed_at = now() WHERE id = $1 AND tenant_id = 'local' AND brain_id = $3", [runId, JSON.stringify({ ...intent, result }), snapshot.brainId]);
 return result;
}

/** Persist a bounded, deduplicated failure receipt without storing transcript payloads. */
export async function ingestConversation(dependencies: { repository: BrainRepository; store: BrainStore }, context: OperationContext, input: { conversation: unknown; dryRun?: boolean }): Promise<ConversationIngestionResult> {
 try { return await ingestConversationAttempt(dependencies, context, input); }
 catch (error) {
  if (!input.dryRun && context.scope === "admin" && context.allowedAccessLabels === undefined && (!context.tenantId || context.tenantId === "local")) {
   try {
    const conversation = conversationInput(input.conversation);
    const snapshot = await dependencies.repository.snapshot();
    if (!context.brainId || context.brainId === snapshot.brainId) {
     const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "conversation_ingestion_failed";
     const inputHash = hash(JSON.stringify(conversation));
     await dependencies.store.query("INSERT INTO brain_source_failures (id, tenant_id, brain_id, source_id, status, reason, metadata) VALUES ($1, 'local', $2, $3, 'failed', $4, $5::jsonb) ON CONFLICT (id) DO NOTHING", [uuidv5("conversation-failure:" + snapshot.brainId + ":" + inputHash + ":" + code), snapshot.brainId, "conversation:" + conversation.provider + ":" + conversation.sourceId, code, JSON.stringify({ inputHash })]);
    }
   } catch { /* Preserve the primary failure if the operational store is unavailable. */ }
  }
  throw error;
 }
}
