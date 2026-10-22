import { createHash, randomUUID } from "node:crypto";
import type { BrainStore } from "./store";
import type { BrainRepository } from "./repository";
import { GoogleReadClient, GoogleApiError } from "../sources/google-api";
import { readGooglePage, googleBoundaryHash, googleSourceId, type GoogleBoundary, type GoogleCursor, type GooglePage } from "../sources/google-pages";
import { assertNormalizedDocuments } from "../sources/conformance";
import { syncSource } from "../sources/sync";
import { enqueueJob } from "./jobs";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const parse = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) : value as T;
export class GoogleSyncError extends Error {
 readonly retryAfterMs = 1000;
 readonly retryable = true; readonly code = "google_source_busy";
 readonly suggestedFix = "Retry the selected source after its active lease expires or finishes.";
 constructor() { super("The selected Google source is unavailable or leased by another worker."); }
}
export type GoogleSyncReceipt = { sourceId: string; batchId: string; applied: number; complete: boolean; reconciled: boolean; cursor: GoogleCursor };
export type GoogleSyncFault = "after-fetch" | "after-git-write" | "before-checkpoint";
type SourceRow = { id: string; cursor: unknown; reconciliation_id: string | null; revision: string; checkpoint_sequence: number | string };
export async function syncGooglePage(options: { store: BrainStore; repository: BrainRepository; client: GoogleReadClient; boundary: GoogleBoundary; workerId: string; expectedRevision?: string; onCheckpoint?: (transaction: BrainStore, receipt: GoogleSyncReceipt) => Promise<void>; assertAccess?: () => Promise<void>; faultInjector?: (point: GoogleSyncFault) => Promise<void> }) {
 const { store, repository, boundary } = options;
 await options.assertAccess?.();
 const workerId = options.workerId + ":" + randomUUID();
 const boundaryHash = googleBoundaryHash(boundary), sourceId = googleSourceId(boundary), brainId = (await repository.getIdentity()).brainId;
 const revision = options.expectedRevision ?? boundaryHash;
 await store.query("INSERT INTO brain_google_sources (id,tenant_id,brain_id,boundary,revision) VALUES ($1,'local',$2,$3::jsonb,$4) ON CONFLICT (tenant_id,brain_id,id) DO NOTHING", [sourceId, brainId, JSON.stringify(boundary), revision]);
 const leased = await store.query<SourceRow>("UPDATE brain_google_sources SET worker_id=$3,lease_expires_at=now()+interval '60 seconds' WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND enabled=true AND revision=$4 AND (worker_id IS NULL OR lease_expires_at<=now()) RETURNING id,cursor,reconciliation_id,revision,checkpoint_sequence", [sourceId, brainId, workerId, revision]);
 if (!leased[0]) throw new GoogleSyncError();
 const source = leased[0], cursor = source.cursor === null ? undefined : parse<GoogleCursor>(source.cursor);
 const cursorHash = hash(JSON.stringify([cursor ?? null, String(source.checkpoint_sequence)]));
 const batchId = hash(JSON.stringify([brainId, sourceId, revision, cursorHash]));
 let lostLease: unknown, renewal = Promise.resolve();
 const check = async () => {
  if (lostLease) throw lostLease;
  await options.assertAccess?.();
  const rows = await store.query<{ id: string }>("UPDATE brain_google_sources SET lease_expires_at=now()+interval '60 seconds' WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND worker_id=$3 AND revision=$4 AND enabled=true AND lease_expires_at>now() RETURNING id", [sourceId, brainId, workerId, revision]);
  if (!rows.length) throw new GoogleSyncError();
 };
 const timer = setInterval(() => { renewal = renewal.then(check).catch((error) => { lostLease = error; }); }, 10000);
 let batch: { page: unknown; applied: number; reconciliation_id: string | null } | undefined;
 try {
  const stored = await store.query<{ page: unknown; applied: number; reconciliation_id: string | null }>("SELECT page,applied,reconciliation_id FROM brain_google_batches WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND status='pending'", [batchId, brainId]);
  batch = stored[0];
  if (!batch) {
   const page = await readGooglePage(options.client, boundary, cursor);
   assertNormalizedDocuments(sourceId, page.documents);
   if (Buffer.byteLength(JSON.stringify(page)) > 16 * 1024 * 1024) throw new GoogleApiError("page_byte_budget_exceeded", 0, false);
   await options.faultInjector?.("after-fetch");
   await check();
   const full = !cursor || cursor.phase === "full" || page.reconciled;
   const reconciliationId = full ? page.reconciled ? randomUUID() : source.reconciliation_id ?? randomUUID() : null;
   const inserted = await store.query<{ page: unknown; applied: number; reconciliation_id: string | null }>("INSERT INTO brain_google_batches (id,tenant_id,brain_id,source_id,cursor_hash,page,reconciliation_id) VALUES ($1,'local',$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO UPDATE SET page=brain_google_batches.page RETURNING page,applied,reconciliation_id", [batchId, brainId, sourceId, cursorHash, JSON.stringify(page), reconciliationId]);
   batch = inserted[0];
  }
  if (!batch) throw new Error("Google page journal is unavailable");
  const page = parse<GooglePage>(batch.page);
  if (page.next.boundaryHash !== boundaryHash || !Number.isInteger(batch.applied) || batch.applied < 0 || batch.applied > page.documents.length) throw new Error("Google page journal is invalid");
  assertNormalizedDocuments(sourceId, page.documents);
  for (let index = batch.applied; index < page.documents.length; index++) {
   await check();
   const document = page.documents[index]!;
   await syncSource({ id: sourceId, describe: () => ({ id: sourceId, version: "1", kind: "google:" + boundary.service, trusted: true }), scan: async function* () { yield document; } }, repository);
   await options.faultInjector?.("after-git-write");
   await check();
   await store.transaction(async (transaction) => {
    if (batch!.reconciliation_id) await transaction.query("INSERT INTO brain_google_seen (tenant_id,brain_id,source_id,reconciliation_id,external_id) VALUES ('local',$1,$2,$3,$4) ON CONFLICT DO NOTHING", [brainId, sourceId, batch!.reconciliation_id, document.externalId]);
    await transaction.query("UPDATE brain_google_batches SET applied=$2 WHERE id=$1 AND tenant_id='local' AND brain_id=$3 AND status='pending'", [batchId, index + 1, brainId]);
   });
  }
  if (page.complete && batch.reconciliation_id) {
   const seen = await store.query<{ external_id: string }>("SELECT external_id FROM brain_google_seen WHERE tenant_id='local' AND brain_id=$1 AND source_id=$2 AND reconciliation_id=$3", [brainId, sourceId, batch.reconciliation_id]);
   const present = new Set(seen.map((row) => row.external_id));
   for (const entry of (await repository.listPages()).filter((entry) => entry.source?.type === sourceId && !present.has(entry.source.externalId))) { await check(); await repository.markStaleBySource(sourceId, entry.source!.externalId); }
  }
  await options.faultInjector?.("before-checkpoint");
  await check();
  const receipt: GoogleSyncReceipt = { sourceId, batchId, applied: page.documents.length, complete: page.complete, reconciled: page.reconciled, cursor: page.next };
  await store.transaction(async (transaction) => {
   await enqueueJob(transaction, { type: "projection", payload: { brainId, repositoryRoot: repository.root }, idempotencyKey: "google-projection:" + batchId });
   const updated = await transaction.query<{ id: string }>("UPDATE brain_google_sources SET cursor=$5::jsonb,checkpoint_sequence=checkpoint_sequence+1,reconciliation_id=$6,last_success_at=now(),last_error=NULL WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND worker_id=$3 AND revision=$4 AND enabled=true AND lease_expires_at>now() RETURNING id", [sourceId, brainId, workerId, revision, JSON.stringify(page.next), page.complete ? null : batch!.reconciliation_id]);
   if (!updated.length) throw new GoogleSyncError();
   await options.onCheckpoint?.(transaction, receipt);
   await transaction.query("UPDATE brain_google_batches SET status='complete',completed_at=now() WHERE id=$1 AND tenant_id='local' AND brain_id=$2", [batchId, brainId]);
  });
  return receipt;
 } catch (error) {
  const code = error instanceof GoogleApiError ? error.code : error instanceof GoogleSyncError ? error.code : "persistence_failed";
  await store.transaction(async (transaction) => {
   await transaction.query("INSERT INTO brain_google_attempts (id,tenant_id,brain_id,source_id,batch_id,error_code,retryable,retry_after_ms) VALUES ($1,'local',$2,$3,$4,$5,$6,$7)", [randomUUID(), brainId, sourceId, batchId, code, !(error instanceof GoogleApiError) || error.retryable, error instanceof GoogleApiError ? error.retryAfterMs : 1000]);
   await transaction.query("UPDATE brain_google_sources SET last_error=$4 WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND worker_id=$3", [sourceId, brainId, workerId, code]);
  });
  throw error;
 } finally {
  clearInterval(timer); await renewal;
  await store.query("UPDATE brain_google_sources SET worker_id=NULL,lease_expires_at=NULL WHERE id=$1 AND tenant_id='local' AND brain_id=$2 AND worker_id=$3", [sourceId, brainId, workerId]);
 }
}
