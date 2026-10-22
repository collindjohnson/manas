import { createHash, randomUUID } from "node:crypto";
import type { BrainStore } from "./store";
import type { BrainRepository } from "./repository";
import type { OperationContext } from "./operation-registry";
import { enqueueJob, type BrainJob } from "./jobs";
import { syncGooglePage } from "./google-sync";
import { googleBoundaryHash, googleSourceId, validateGoogleBoundary, type GoogleBoundary } from "../sources/google-pages";
import { createGoogleAccountClient, type GoogleCredentialAccess } from "../sources/google-account-client";
import { MacGoogleCredentialStore } from "../sources/google-keychain";
import { validateGoogleCredential } from "../sources/google-oauth";
import { GoogleApiError } from "../sources/google-api";

export const runtimeGoogleCredentials = new MacGoogleCredentialStore();
const parse = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) : value as T;
type Dependencies = { store: BrainStore; repository: BrainRepository; credentials?: GoogleCredentialAccess };
type Source = { id: string; revision: string; boundary: unknown; enabled: boolean };
async function owner(dependencies: Dependencies, context: OperationContext) {
 const brainId = (await dependencies.repository.getIdentity()).brainId;
 if (context.scope !== "admin" || context.tenantId && context.tenantId !== "local" || context.brainId && context.brainId !== brainId) throw new GoogleApiError("owner_access_required", 403, false);
 return brainId;
}
export async function addGoogleSource(dependencies: Dependencies, context: OperationContext, boundaryInput: GoogleBoundary) {
 const brainId = await owner(dependencies, context), boundary = structuredClone(validateGoogleBoundary(boundaryInput));
 if (context.allowedAccessLabels && boundary.visibility.some((label) => !context.allowedAccessLabels!.includes(label))) throw new GoogleApiError("source_visibility_denied", 403, false);
 const credential = validateGoogleCredential(await (dependencies.credentials ?? runtimeGoogleCredentials).get(boundary.accountId));
 const scope = { gmail: "https://www.googleapis.com/auth/gmail.readonly", calendar: "https://www.googleapis.com/auth/calendar.readonly", contacts: "https://www.googleapis.com/auth/contacts.readonly" }[boundary.service];
 if (credential.accountId !== boundary.accountId || credential.email.toLowerCase() !== boundary.accountEmail.toLowerCase() || !credential.scopes.includes(scope)) throw new GoogleApiError("selected_account_or_scope_mismatch", 403, false);
 const id = googleSourceId(boundary), revision = googleBoundaryHash(boundary);
 await dependencies.store.query("INSERT INTO brain_google_sources (id,tenant_id,brain_id,boundary,revision) VALUES ($1,'local',$2,$3::jsonb,$4) ON CONFLICT (tenant_id,brain_id,id) DO NOTHING", [id, brainId, JSON.stringify(boundary), revision]);
 const existing = (await dependencies.store.query<Source>("SELECT id,revision,boundary,enabled FROM brain_google_sources WHERE tenant_id='local' AND brain_id=$1 AND id=$2", [brainId, id]))[0]!;
 return { id, revision: existing.revision, brainId, enabled: existing.enabled };
}
export async function setGoogleSourceEnabled(dependencies: Dependencies, context: OperationContext, input: { id: string; expectedRevision: string; enabled: boolean; idempotencyKey: string }) {
 const brainId = await owner(dependencies, context);
 if (typeof input.enabled !== "boolean" || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128 || typeof input.id !== "string" || typeof input.expectedRevision !== "string") throw new GoogleApiError("invalid_source_mutation", 0, false);
 const principal = context.principal ?? "local-owner";
 const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
 const key = "google-source:" + digest([brainId, principal, input.idempotencyKey]);
 const requestHash = digest([brainId, input.id, input.expectedRevision, input.enabled]);
 const action = input.enabled ? "google.source.enable" : "google.source.disable";
 return dependencies.store.transaction(async (transaction) => {
  const source = (await transaction.query<Source>("SELECT id,revision,boundary,enabled FROM brain_google_sources WHERE tenant_id='local' AND brain_id=$1 AND id=$2 FOR UPDATE", [brainId, input.id]))[0];
  if (!source) throw new GoogleApiError("source_unavailable_or_changed", 409, false);
  const boundary = validateGoogleBoundary(parse<GoogleBoundary>(source.boundary));
  if (context.allowedAccessLabels && boundary.visibility.some((label) => !context.allowedAccessLabels!.includes(label))) throw new GoogleApiError("source_visibility_denied", 403, false);
  const existing = (await transaction.query<{ action: string; target_id: string; principal: string; result: unknown }>("SELECT action,target_id,principal,result FROM brain_admin_action_receipts WHERE tenant_id='local' AND idempotency_key=$1", [key]))[0];
  if (existing) {
   const saved = parse<{ requestHash: string; id: string; revision: string; enabled: boolean; brainId: string }>(existing.result);
   if (existing.action !== action || existing.target_id !== source.id || existing.principal !== principal || saved.requestHash !== requestHash) throw new GoogleApiError("idempotency_conflict", 409, false);
   return { id: saved.id, revision: saved.revision, enabled: saved.enabled, brainId, replayed: true };
  }
  if (source.revision !== input.expectedRevision) throw new GoogleApiError("source_unavailable_or_changed", 409, false);
  const revision = source.enabled === input.enabled ? source.revision : randomUUID();
  if (source.enabled !== input.enabled) await transaction.query("UPDATE brain_google_sources SET enabled=$3,revision=$4,worker_id=NULL,lease_expires_at=NULL WHERE tenant_id='local' AND brain_id=$1 AND id=$2", [brainId, source.id, input.enabled, revision]);
  if (!input.enabled) {
   await transaction.query("UPDATE brain_jobs SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id='local' AND type='google-source-sync' AND payload->>'brainId'=$1 AND payload->>'sourceId'=$2 AND status IN ('pending','running')", [brainId, source.id]);
   await transaction.query("UPDATE brain_job_schedules SET enabled=false,updated_at=now() WHERE tenant_id='local' AND type='google-source-sync' AND payload->>'brainId'=$1 AND payload->>'sourceId'=$2", [brainId, source.id]);
  }
  const result = { id: source.id, revision, enabled: input.enabled, brainId };
  const receipt = await transaction.query("INSERT INTO brain_admin_action_receipts (id,tenant_id,action,target_id,principal,idempotency_key,status,result,completed_at) VALUES ($1,'local',$2,$3,$4,$5,'complete',$6::jsonb,now()) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id", [randomUUID(), action, source.id, principal, key, JSON.stringify({ ...result, requestHash })]);
  if (!receipt.length) throw new GoogleApiError("idempotency_conflict", 409, false);
  return { ...result, replayed: false };
 });
}
export async function scheduleGoogleSource(dependencies: Dependencies, context: OperationContext, input: { id: string; expectedRevision: string; intervalSeconds: number; enabled: boolean; idempotencyKey: string; maximumPages?: number; runImmediately?: boolean }) {
 const brainId = await owner(dependencies, context), maximumPages = input.maximumPages ?? 1000, immediate = input.runImmediately ?? false;
 if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 60 || input.intervalSeconds > 86400 || typeof input.enabled !== "boolean" || typeof immediate !== "boolean" || !input.enabled && immediate || !Number.isInteger(maximumPages) || maximumPages < 1 || maximumPages > 1000 || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128) throw new GoogleApiError("invalid_source_schedule", 0, false);
 const principal = context.principal ?? "local-owner", digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
 const key = "google-source:" + digest([brainId, principal, input.idempotencyKey]), requestHash = digest([brainId, input.id, input.expectedRevision, input.intervalSeconds, input.enabled, maximumPages, immediate]);
 return dependencies.store.transaction(async (transaction) => {
  const source = (await transaction.query<Source>("SELECT id,revision,boundary,enabled FROM brain_google_sources WHERE tenant_id='local' AND brain_id=$1 AND id=$2 FOR UPDATE", [brainId, input.id]))[0];
  if (!source) throw new GoogleApiError("source_unavailable_or_changed", 409, false);
  const boundary = validateGoogleBoundary(parse<GoogleBoundary>(source.boundary));
  if (context.allowedAccessLabels && boundary.visibility.some((label) => !context.allowedAccessLabels!.includes(label))) throw new GoogleApiError("source_visibility_denied", 403, false);
  const existing = (await transaction.query<{ action: string; target_id: string; principal: string; result: unknown }>("SELECT action,target_id,principal,result FROM brain_admin_action_receipts WHERE tenant_id='local' AND idempotency_key=$1", [key]))[0];
  if (existing) {
   const saved = parse<{ requestHash: string; schedule: { id: string; sourceId: string; revision: string; intervalSeconds: number; enabled: boolean; maximumPages: number; nextRunAt: string } }>(existing.result);
   if (existing.action !== "google.source.schedule" || existing.target_id !== source.id || existing.principal !== principal || saved.requestHash !== requestHash) throw new GoogleApiError("idempotency_conflict", 409, false);
   return { ...saved.schedule, replayed: true };
  }
  if (source.revision !== input.expectedRevision || input.enabled && !source.enabled) throw new GoogleApiError("source_unavailable_or_changed", 409, false);
  const id = "google-schedule:" + digest([brainId, source.id]);
  const payload = { brainId, sourceId: source.id, revision: source.revision, pageNumber: 1, maximumPages };
  const nextRunAt = new Date(Date.now() + (immediate ? 0 : input.intervalSeconds * 1000)).toISOString();
  const rows = await transaction.query("INSERT INTO brain_job_schedules (id,tenant_id,type,payload,interval_seconds,next_run_at,enabled) VALUES ($1,'local','google-source-sync',$2::jsonb,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload,interval_seconds=EXCLUDED.interval_seconds,next_run_at=EXCLUDED.next_run_at,enabled=EXCLUDED.enabled,updated_at=now() WHERE brain_job_schedules.tenant_id='local' AND brain_job_schedules.type='google-source-sync' AND brain_job_schedules.payload->>'brainId'=$6 AND brain_job_schedules.payload->>'sourceId'=$7 RETURNING id", [id, JSON.stringify(payload), input.intervalSeconds, nextRunAt, input.enabled, brainId, source.id]);
  if (!rows.length) throw new GoogleApiError("schedule_ownership_conflict", 409, false);
  const schedule = { id, sourceId: source.id, revision: source.revision, intervalSeconds: input.intervalSeconds, enabled: input.enabled, maximumPages, nextRunAt };
  const receipt = await transaction.query("INSERT INTO brain_admin_action_receipts (id,tenant_id,action,target_id,principal,idempotency_key,status,result,completed_at) VALUES ($1,'local','google.source.schedule',$2,$3,$4,'complete',$5::jsonb,now()) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id", [randomUUID(), source.id, principal, key, JSON.stringify({ requestHash, schedule })]);
  if (!receipt.length) throw new GoogleApiError("idempotency_conflict", 409, false);
  return { ...schedule, replayed: false };
 });
}
export async function googleSourceStatus(dependencies: Dependencies, context: OperationContext) {
 const brainId = await owner(dependencies, context);
 const rows = await dependencies.store.query<{ id: string; revision: string; boundary: unknown; enabled: boolean; cursor: unknown; running: boolean; checkpoint_sequence: string | number; last_success_at: string | null; last_error: string | null }>("SELECT id,revision,boundary,enabled,cursor,(worker_id IS NOT NULL AND lease_expires_at>now()) AS running,checkpoint_sequence,last_success_at,last_error FROM brain_google_sources WHERE tenant_id='local' AND brain_id=$1 ORDER BY id", [brainId]);
 const schedules = await dependencies.store.query<{ id: string; payload: unknown; enabled: boolean; interval_seconds: number; next_run_at: string }>("SELECT id,payload,enabled,interval_seconds,next_run_at FROM brain_job_schedules WHERE tenant_id='local' AND type='google-source-sync' AND payload->>'brainId'=$1", [brainId]);
 const scheduleFor = (sourceId: string) => {
  const owned = schedules.find((schedule) => parse<{ sourceId?: string }>(schedule.payload)?.sourceId === sourceId);
  return owned ? { id: owned.id, enabled: owned.enabled, revision: parse<{ revision: string }>(owned.payload).revision, intervalSeconds: owned.interval_seconds, nextRunAt: new Date(owned.next_run_at).toISOString() } : null;
 };
 return { sources: rows.filter((row) => !context.allowedAccessLabels || parse<GoogleBoundary>(row.boundary).visibility.every((label) => context.allowedAccessLabels!.includes(label))).map((row) => ({ id: row.id, revision: row.revision, boundary: parse<GoogleBoundary>(row.boundary), enabled: row.enabled, running: row.running, phase: row.cursor ? parse<{ phase: string }>(row.cursor).phase : "not_started", hasMorePages: Boolean(row.cursor && parse<{ pageToken?: string }>(row.cursor).pageToken), checkpoints: Number(row.checkpoint_sequence), lastSuccessAt: row.last_success_at, lastError: row.last_error, schedule: scheduleFor(row.id) })) };
}
export async function enqueueGoogleSync(dependencies: Dependencies, context: OperationContext, input: { id: string; expectedRevision: string; idempotencyKey: string; maximumPages?: number }) {
 const brainId = await owner(dependencies, context);
 const sources = await dependencies.store.query<Source>("SELECT id,revision,boundary,enabled FROM brain_google_sources WHERE tenant_id='local' AND brain_id=$1 AND id=$2", [brainId, input.id]);
 const source = sources[0];
 if (!source?.enabled || source.revision !== input.expectedRevision) throw new GoogleApiError("source_unavailable_or_changed", 409, false);
 if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128) throw new GoogleApiError("invalid_idempotency_key", 0, false);
 const boundary = validateGoogleBoundary(parse<GoogleBoundary>(source.boundary));
 if (context.allowedAccessLabels && boundary.visibility.some((label) => !context.allowedAccessLabels!.includes(label))) throw new GoogleApiError("source_visibility_denied", 403, false);
 const maximumPages = input.maximumPages ?? 1000;
 if (!Number.isInteger(maximumPages) || maximumPages < 1 || maximumPages > 1000) throw new GoogleApiError("invalid_page_budget", 0, false);
 const job = await enqueueJob(dependencies.store, { type: "google-source-sync", tenantId: "local", maxAttempts: 8, idempotencyKey: "google-sync:" + brainId + ":" + input.idempotencyKey, payload: { brainId, sourceId: source.id, revision: source.revision, pageNumber: 1, maximumPages } });
 const queued = job.payload as Record<string, unknown>;
 if (queued.sourceId !== source.id || queued.revision !== source.revision || queued.maximumPages !== maximumPages || queued.brainId !== brainId) throw new GoogleApiError("idempotency_conflict", 409, false);
 return { jobId: job.id, sourceId: source.id };
}
export function googleSyncHandler(dependencies: Dependencies & { workerId: string; fetcher?: (url: string, init: RequestInit) => Promise<Response> }) {
 return async (job: BrainJob) => {
  const payload = job.payload as { brainId: string; sourceId: string; revision: string; pageNumber: number; maximumPages: number };
  const brainId = (await dependencies.repository.getIdentity()).brainId;
  if (!payload || Object.keys(payload).some((key) => !["brainId", "sourceId", "revision", "pageNumber", "maximumPages"].includes(key)) || job.tenantId !== "local" || payload.brainId !== brainId || typeof payload.sourceId !== "string" || typeof payload.revision !== "string" || !Number.isInteger(payload.pageNumber) || !Number.isInteger(payload.maximumPages) || payload.pageNumber < 1 || payload.maximumPages > 1000 || payload.pageNumber > payload.maximumPages) throw new GoogleApiError("invalid_google_job", 0, false);
  const sources = await dependencies.store.query<Source>("SELECT id,revision,boundary,enabled FROM brain_google_sources WHERE tenant_id='local' AND brain_id=$1 AND id=$2", [brainId, payload.sourceId]);
  const source = sources[0];
  if (!source?.enabled || source.revision !== payload.revision) throw new GoogleApiError("source_unavailable_or_changed", 409, false);
  const boundary = validateGoogleBoundary(parse<GoogleBoundary>(source.boundary));
  if (googleSourceId(boundary) !== source.id) throw new GoogleApiError("source_boundary_changed", 409, false);
  const previous = await dependencies.store.query<{ progress: unknown }>("SELECT progress FROM brain_jobs WHERE id=$1 AND tenant_id='local'", [job.id]);
  if (parse<Record<string, unknown>>(previous[0]?.progress ?? {}).googleCheckpointCommitted === true) return;
  const deadline = Date.now() + 120000;
  const guard = async () => {
   if (Date.now() >= deadline) throw new GoogleApiError("page_runtime_budget_exceeded", 0, true, 1000);
   const rows = await dependencies.store.query<{ id: string }>("UPDATE brain_jobs SET lease_expires_at=now()+interval '60 seconds' WHERE id=$1 AND tenant_id='local' AND worker_id=$2 AND attempts=$3 AND status='running' AND lease_expires_at>now() AND EXISTS (SELECT 1 FROM brain_google_sources WHERE tenant_id='local' AND brain_id=$4 AND id=$5 AND enabled=true AND revision=$6) RETURNING id", [job.id, dependencies.workerId, job.attempts, brainId, source.id, source.revision]);
   if (!rows.length) throw new GoogleApiError("google_job_access_lost", 403, false);
  };
  const client = createGoogleAccountClient({ credentials: dependencies.credentials ?? runtimeGoogleCredentials, boundary, assertAccess: guard, fetcher: dependencies.fetcher });
  try {
   await syncGooglePage({ ...dependencies, client, boundary, expectedRevision: source.revision, assertAccess: guard,
    onCheckpoint: async (transaction, receipt) => {
     const budgetExhausted = !receipt.complete && payload.pageNumber >= payload.maximumPages;
     const progress = { googleCheckpointCommitted: true, sourceId: source.id, batchId: receipt.batchId, applied: receipt.applied, complete: receipt.complete, budgetExhausted, pageNumber: payload.pageNumber };
     const updated = await transaction.query("UPDATE brain_jobs SET progress=$4::jsonb WHERE id=$1 AND tenant_id='local' AND worker_id=$2 AND attempts=$3 AND status='running' AND lease_expires_at>now() RETURNING id", [job.id, dependencies.workerId, job.attempts, JSON.stringify(progress)]);
     if (!updated.length) throw new GoogleApiError("google_job_access_lost", 403, false);
     if (!receipt.complete && !budgetExhausted) await enqueueJob(transaction, { type: "google-source-sync", tenantId: "local", maxAttempts: 8, idempotencyKey: "google-continue:" + receipt.batchId, payload: { ...payload, pageNumber: payload.pageNumber + 1 } });
    },
   });
  } catch (error) {
   if (error instanceof GoogleApiError && !error.retryable) await dependencies.store.query("UPDATE brain_jobs SET max_attempts=attempts WHERE id=$1 AND tenant_id='local' AND worker_id=$2 AND attempts=$3 AND status='running'", [job.id, dependencies.workerId, job.attempts]);
   throw error;
  }
 };
}
