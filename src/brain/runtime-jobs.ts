import { reminderDeliveryHandler, listReminders, enqueueReminder } from "./reminders";
import { prepareMeeting } from "./meeting-preparation";
import { updateJobProgress } from "./jobs";
import { maintenanceScanHandler } from "./maintenance-scan";
import { catalogExecutionHandler, type CatalogExecute } from "./catalog-execution";
import { realpath } from "node:fs/promises";
import { googleSyncHandler } from "./google-jobs";
import { pinnedAnswerHandler } from "./maintained-answers";
import { claudeTranscriptHandler } from "./claude-transcript-capture";
import type { BrainProviderBundle } from "../engine";
import type { BrainRepository } from "./repository";
import type { BrainStore } from "./store";
import type { Config } from "../config";
import { createParityJobHandlers } from "./job-handlers";
import { memoryCaptureHandler } from "./memory-capture";
export function createRuntimeJobHandlers(options: { store: BrainStore; repository: BrainRepository; config: Config; providers: BrainProviderBundle; workerId: string; tenantId?: string; executeCatalog?: CatalogExecute }) {
 const handlers = createParityJobHandlers({ store: options.store, repository: options.repository, workerId: options.workerId, tenantId: options.tenantId, authority: "admin", privacy: "local", embeddingProvider: options.providers.embedding, transcriptionProvider: options.providers.transcription, structuredExtractionProvider: options.providers.extraction });
 handlers.index = handlers.indexing;
 handlers.projection = handlers["projection-repair"];
 handlers["memory-capture"] = memoryCaptureHandler({ store: options.store, repository: options.repository, stateRoot: options.config.stateRoot, workerId: options.workerId, provider: options.providers.generation });
 handlers["claude-transcript-capture"] = claudeTranscriptHandler({ store: options.store, repository: options.repository, stateRoot: options.config.stateRoot, workerId: options.workerId });
 const refresh = pinnedAnswerHandler({ store: options.store, repository: options.repository, workerId: options.workerId, provider: options.providers.generation, searchOptions: { embeddingProvider: options.providers.embedding, rerankerProvider: options.providers.reranking } });
 handlers["pinned-answer-refresh"] = async (job) => { await refresh(job); };
 handlers["google-source-sync"] = googleSyncHandler({ store: options.store, repository: options.repository, workerId: options.workerId });
 if (options.executeCatalog) handlers["catalog-execution"] = catalogExecutionHandler({ store: options.store, repository: options.repository, workerId: options.workerId, execute: options.executeCatalog, managedWrites: () => options.config.automation?.managedWrites === true });
 const maintenance = maintenanceScanHandler({ store: options.store, repository: options.repository, workerId: options.workerId, provider: options.providers.generation, managedWrites: () => options.config.automation?.managedWrites === true });
 for (const type of ["maintenance-scan", "fact-extraction", "entity-enrichment", "contradiction-analysis", "deduplication", "staleness-analysis", "dream-maintenance"]) handlers[type] = maintenance;
 handlers["reminder-delivery"] = reminderDeliveryHandler(options);
 handlers.reminders = async (job) => {
  const payload = job.payload as { brainId: string; notify?: boolean };
  if (payload.notify !== undefined && typeof payload.notify !== "boolean") throw new Error("Reminder notify must be an explicit boolean.");
  const context = { scope: "admin" as const, tenantId: job.tenantId, brainId: payload.brainId, principal: "reminder-worker" };
  const check = async () => {
   const live = await options.store.query("UPDATE brain_jobs SET lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='running' AND worker_id=$3 AND attempts=$4 AND lease_expires_at>now() RETURNING id", [job.id, job.tenantId, options.workerId, job.attempts]);
   if (!live.length) throw new Error("Reminder scan cancelled or lease lost.");
  };
  let after: string | undefined, due = 0, requested = 0;
  for (let page = 0; page < 20; page++) {
   await check();
   const result = await listReminders(options.repository, options.store, context, { limit: 100, after });
   due += result.items.length;
   if (payload.notify === true) for (const loop of result.items) { await check(); await enqueueReminder(options.repository, options.store, context, { id: loop.id, expectedRevision: loop.revision }); requested++; }
   if (!result.next) break;
   after = result.next;
  }
  await check();
  await updateJobProgress(options.store, job.id, options.workerId, { due, notificationsRequested: requested, notificationsEnabled: payload.notify === true }, job.tenantId);
 };
 handlers["meeting-preparation"] = async (job) => {
  const controller = new AbortController();
  let checking: Promise<void> | undefined;
  const check = () => checking ??= (async () => {
   const rows = await options.store.query<{ id: string }>("UPDATE brain_jobs SET lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='running' AND worker_id=$3 AND attempts=$4 AND lease_expires_at>now() RETURNING id", [job.id, job.tenantId, options.workerId, job.attempts]);
   if (!rows.length) { controller.abort(); throw new Error("Meeting preparation cancelled or lease lost."); }
  })().finally(() => { checking = undefined; });
  await check();
  const timer = setInterval(() => { void check().catch(() => {}); }, 1000);
  try {
   const payload = job.payload as Record<string, unknown>;
   const result = await prepareMeeting(options.repository, options.store, { scope: "admin", tenantId: job.tenantId, brainId: String(payload.brainId), principal: "meeting-worker", signal: controller.signal }, { idempotencyKey: "meeting-job:" + job.id, meetingId: payload.meetingId as string | undefined, title: payload.title as string | undefined, participants: payload.participants as string[] | undefined, since: payload.since as string | undefined, maximumEvidence: payload.maximumEvidence as number | undefined }, { embeddingProvider: options.providers.embedding, rerankerProvider: options.providers.reranking }, check);
   await check();
   await updateJobProgress(options.store, job.id, options.workerId, { preparationId: result.id, freshness: result.freshness }, job.tenantId);
  } finally { clearInterval(timer); }
 };
 const bound: typeof handlers = {};
 for (const [type, handler] of Object.entries(handlers)) bound[type] = async (job) => {
  const invalid = (code: string, message: string) => Object.assign(new Error(message), { code, retryable: false, suggestedFix: "Queue this work through the configured brain and its authorized operation catalog." });
  const identity = await options.repository.getIdentity();
  if (job.tenantId !== (options.tenantId ?? "local")) throw invalid("job_scope_mismatch", "The job tenant is outside the configured runtime.");
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) throw invalid("invalid_job_payload", "The job payload must be an object.");
  const payload = job.payload as Record<string, unknown>;
  if (payload.brainId !== undefined && payload.brainId !== identity.brainId) throw invalid("job_scope_mismatch", "The job brain is outside the configured runtime.");
  if (payload.repositoryRoot !== undefined) {
   if (typeof payload.repositoryRoot !== "string" || !payload.repositoryRoot.trim()) throw invalid("job_repository_mismatch", "The job repository is invalid.");
   const requested = await realpath(payload.repositoryRoot).catch(() => undefined);
   if (requested !== await realpath(options.repository.root)) throw invalid("job_repository_mismatch", "The job repository is outside the configured runtime.");
  }
  if (type === "source-synchronization" && (typeof payload.sourceId !== "string" || /^(manas-|google:)/.test(payload.sourceId) || payload.sourceId === "legacy-archive")) throw invalid("reserved_source", "Generic synchronization cannot impersonate a managed source.");
  await handler({ ...job, payload: { ...payload, brainId: identity.brainId, ...(["index", "indexing", "projection", "projection-repair", "source-synchronization"].includes(type) ? { repositoryRoot: options.repository.root } : {}) } });
 };
 return bound;
}
