import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import type { BrainRepository } from "./repository";
import type { BrainStore } from "./store";
import type { OperationContext } from "./operation-registry";
import type { SourceAdapter, SourceCheckpoint } from "../sources/types";
import { FilesystemSourceAdapter } from "../sources/filesystem";
import { createAuditQuarantineSink, createPgliteIngestionRunLifecycle, syncSource } from "../sources/sync";
import { importEml, importMbox, importIcs, importMeeting } from "../sources/generic-imports";
import { captureBrainNote } from "./capture";

export const LOCAL_INGESTION_CATALOG = [
 { name: "notes.capture", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["content"], properties: { content: { type: "string" } }, additionalProperties: false } },
 { name: "sources.filesystem.sync", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["path"], properties: { path: { type: "string" }, sourceId: { type: "string" } }, additionalProperties: false } },
 { name: "sources.local.import", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["path", "format"], properties: { path: { type: "string" }, format: { type: "string", enum: ["eml", "mbox", "ics", "meeting"] }, sourceId: { type: "string" } }, additionalProperties: false } },
] as const;
type Dependencies = { repository: BrainRepository; store: BrainStore };
function fail(code: string, message: string, fix: string): never { throw Object.assign(new Error(message), { code, retryable: false, suggestedFix: fix }); }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const queues = new WeakMap<BrainStore, Map<string, Promise<void>>>();
async function serialized<T>(store: BrainStore, key: string, action: () => Promise<T>): Promise<T> {
 let queue = queues.get(store);
 if (!queue) { queue = new Map(); queues.set(store, queue); }
 const previous = queue.get(key);
 let release!: () => void;
 const pending = new Promise<void>((done) => { release = done; });
 queue.set(key, pending);
 await previous;
 try { return await action(); } finally { release(); if (queue.get(key) === pending) queue.delete(key); }
}
export async function executeLocalIngestion(dependencies: Dependencies, context: OperationContext, name: string, input: Record<string, unknown>) {
 const { repository, store } = dependencies;
 const identity = await repository.getIdentity();
 if (context.scope !== "admin" || context.allowedAccessLabels !== undefined || context.tenantId && context.tenantId !== "local" || context.brainId && context.brainId !== identity.brainId) fail("owner_access_required", "Local ingestion requires the brain owner.", "Use the authenticated local owner service.");
 const check = () => context.signal?.throwIfAborted();
 check();
 if (name === "notes.capture") {
  const content = String(input.content);
  if (Buffer.byteLength(content) > 1024 * 1024) fail("input_too_large", "Note exceeds one MiB.", "Capture a smaller note or import a source.");
  return serialized(store, identity.brainId + ":notes", async () => { check(); return captureBrainNote(repository, content); });
 }
 const sourceId = String(input.sourceId ?? (name === "sources.filesystem.sync" ? "filesystem" : "local-import:" + input.format));
 if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(sourceId) || /^(manas-|google:)/.test(sourceId) || sourceId === "legacy-archive") fail("reserved_source", "Source ID is invalid or reserved.", "Choose an ordinary local source ID.");
 const path = String(input.path);
 if (!isAbsolute(path)) fail("invalid_path", "Local source paths must be absolute.", "Pass an absolute source path.");
 const info = await lstat(path);
 if (info.isSymbolicLink() || (name === "sources.filesystem.sync" ? !info.isDirectory() : !info.isFile())) fail("invalid_path", "Source has the wrong file type.", "Select a regular file or directory without a symbolic link.");
 const canonical = await realpath(path);
 const root = await realpath(repository.root);
 const within = (parent: string, child: string) => { const value = relative(parent, child); return !value || value !== ".." && !value.startsWith(".." + sep) && !isAbsolute(value); };
 if (name === "sources.filesystem.sync" && (within(canonical, root) || within(root, canonical))) fail("source_overlaps_brain", "Filesystem source overlaps the canonical brain.", "Select a separate source directory.");
 const binding = name === "sources.filesystem.sync" ? { kind: "filesystem", root: canonical } : { kind: "import", format: String(input.format) };
 const key = "local-source:" + digest(JSON.stringify(["local", identity.brainId, sourceId]));
 return serialized(store, key, async () => {
  check();
  const rows = await store.query<{ value: unknown }>("SELECT value FROM brain_operational_state WHERE key=$1", [key]);
  const state = rows[0] ? (typeof rows[0].value === "string" ? JSON.parse(rows[0].value) : rows[0].value) as { binding: typeof binding; checkpoint?: SourceCheckpoint } : undefined;
  if (state && JSON.stringify(state.binding) !== JSON.stringify(binding)) fail("source_binding_conflict", "Source ID already belongs to another directory or format.", "Reuse the original boundary or choose another source ID.");
  if (!state) await store.query("INSERT INTO brain_operational_state (key,value) VALUES ($1,$2::jsonb)", [key, JSON.stringify({ binding })]);
  let adapter: SourceAdapter;
  let imported: number | undefined;
  if (name === "sources.filesystem.sync") {
   const filesystem = new FilesystemSourceAdapter(canonical, sourceId);
   // Upgrade older command records without replacing their stable IDs.
   const existing = await repository.listPages(true);
   const ids = new Map(await Promise.all(existing.filter((page) => page.source?.type === sourceId && page.source.provenance?.sourcePath).map(async (page) => [await realpath(page.source!.provenance!.sourcePath!).catch(() => resolve(page.source!.provenance!.sourcePath!)), page.source!.externalId] as const)));
   const relativeIds = new Map(existing.filter((page) => page.source?.type === sourceId && page.source.provenance?.sourcePath && !isAbsolute(page.source.provenance.sourcePath)).map((page) => [page.path, page.source!.externalId]));
   adapter = { id: sourceId, describe: () => filesystem.describe(), checkpoint: () => filesystem.checkpoint(), scan: async function* (checkpoint) {
    for await (const document of filesystem.scan(checkpoint)) { check(); yield { ...document, externalId: ids.get(resolve(document.provenance.sourcePath)) ?? relativeIds.get(document.suggestedPath) ?? document.externalId }; }
   } };
  } else {
   if (info.size > 4 * 1024 * 1024) fail("input_too_large", "Import exceeds four MiB.", "Split the import into smaller files.");
   const text = await readFile(canonical, "utf8");
   if (Buffer.byteLength(text) > 4 * 1024 * 1024) fail("input_too_large", "Import exceeds four MiB.", "Split the import into smaller files.");
   const format = String(input.format);
   if (!["eml", "mbox", "ics", "meeting"].includes(format)) fail("invalid_format", "Unsupported import format.", "Use eml, mbox, ics, or meeting.");
   const documents = format === "eml" ? [importEml(text)] : format === "mbox" ? importMbox(text) : format === "ics" ? importIcs(text) : [importMeeting(text)];
   imported = documents.length;
   // A file is a delivery, not a complete inventory of this source.
   adapter = { id: sourceId, describe: () => ({ id: sourceId, version: "1", kind: format, trusted: true }), scan: async function* () { for (const document of documents) { check(); yield document; } } };
  }
  // Store ownership and the per-source queue prove any older running receipt
  // has no live ingestion attached to it. Retain it as an interrupted failure.
  await store.query("WITH interrupted AS (UPDATE brain_ingestion_runs SET status='failed',completed_at=now() WHERE tenant_id='local' AND brain_id=$1 AND source_id=$2 AND status='running' RETURNING id,source_id) INSERT INTO brain_source_failures (id,tenant_id,brain_id,source_id,ingestion_run_id,status,reason,metadata) SELECT 'interrupted:' || id,'local',$1,source_id,id,'failed','interrupted_ingestion','{}'::jsonb FROM interrupted", [identity.brainId, sourceId]);
  const snapshotSettings = await repository.getSettings();
  const lifecycle = createPgliteIngestionRunLifecycle(store, "local", identity.brainId, snapshotSettings.schemaPack, repository.root);
  const checkpoints = {
   get: async () => state?.checkpoint,
   set: async (_id: string, checkpoint: SourceCheckpoint) => { check(); await store.query("UPDATE brain_operational_state SET value=$2::jsonb,updated_at=now() WHERE key=$1", [key, JSON.stringify({ binding, checkpoint })]); },
  };
  const guarded = new Proxy(repository, { get(target, property) {
   const value = Reflect.get(target, property);
   return typeof value === "function" ? (...args: unknown[]) => { check(); return value.apply(target, args); } : value;
  } });
  const result = await syncSource(adapter, guarded, checkpoints, createAuditQuarantineSink(store), lifecycle);
  return imported === undefined ? result : { ...result, sourceId, imported };
 });
}
