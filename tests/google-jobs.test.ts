import { createFullOperationRegistry } from "../src/brain/operation-catalog";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { openPgliteBrainStore } from "../src/brain/store";
import { BrainRepository } from "../src/brain/repository";
import { addGoogleSource, enqueueGoogleSync, googleSourceStatus, googleSyncHandler, setGoogleSourceEnabled, scheduleGoogleSource } from "../src/brain/google-jobs";
import { claimJob, runOneJob, cancelJob, listJobs, materializeDueSchedules } from "../src/brain/jobs";
import { indexBrainRepository } from "../src/brain/pglite-indexer";
import type { GoogleCredential } from "../src/sources/google-oauth";
import type { GoogleBoundary } from "../src/sources/google-pages";
const accountId = createHash("sha256").update("google:subject").digest("hex");
const boundary: GoogleBoundary = { accountId, accountEmail: "owner@example.invalid", service: "contacts", visibility: ["personal"], groupIds: [], allContacts: true };
const owner = { scope: "admin" as const, tenantId: "local" };
async function fixture(action: (dependencies: { store: Awaited<ReturnType<typeof openPgliteBrainStore>>; repository: BrainRepository; credentials: { get: () => Promise<GoogleCredential>; replace: (expected: GoogleCredential, next: GoogleCredential) => Promise<void> } }) => Promise<void>) {
 const root = await mkdtemp(join(tmpdir(), "manas-google-jobs-")), store = await openPgliteBrainStore(join(root, "state")), repository = new BrainRepository(join(root, "brain"));
 try {
  await repository.initialize();
  const run = promisify(execFile);
  await run("git", ["-C", repository.root, "config", "user.name", "Test"]);
  await run("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  let credential: GoogleCredential = { version: 1, accountId, subject: "subject", email: boundary.accountEmail, clientId: "123-example.apps.googleusercontent.com", clientSecret: "private-client-secret", refreshToken: "private-refresh", accessToken: "private-access", expiresAt: Date.now() + 3600000, scopes: ["openid", "email", "https://www.googleapis.com/auth/contacts.readonly"] };
  await action({ store, repository, credentials: { get: async () => structuredClone(credential), replace: async (expected, next) => { expect(credential.accessToken).toBe(expected.accessToken); credential = next; } } });
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}
test("Google queue atomically persists page receipts and continuation jobs and replays a post-checkpoint crash", async () => fixture(async (dependencies) => {
 const source = await addGoogleSource(dependencies, owner, boundary);
 expect(await addGoogleSource(dependencies, owner, boundary)).toEqual(source);
 await expect(addGoogleSource(dependencies, { scope: "write" }, boundary)).rejects.toMatchObject({ code: "owner_access_required" });
 const queued = await enqueueGoogleSync(dependencies, owner, { id: source.id, expectedRevision: source.revision, idempotencyKey: "first" });
 expect(await enqueueGoogleSync(dependencies, owner, { id: source.id, expectedRevision: source.revision, idempotencyKey: "first" })).toEqual(queued);
 await expect(enqueueGoogleSync(dependencies, owner, { id: source.id, expectedRevision: source.revision, idempotencyKey: "first", maximumPages: 1 })).rejects.toMatchObject({ code: "idempotency_conflict" });
 let requests = 0;
 const handler = googleSyncHandler({ ...dependencies, workerId: "worker", fetcher: async (url) => {
  requests++;
  const second = new URL(url).searchParams.has("pageToken");
  return Response.json({ connections: [{ resourceName: second ? "people/two" : "people/one", metadata: {}, names: [{ displayName: second ? "Juniper maintainer Maya" : "Juniper reviewer Chen" }] }], ...(second ? { nextSyncToken: "finished" } : { nextPageToken: "second" }) });
 } });
 const claimed = await claimJob(dependencies.store, "worker");
 expect(claimed!.id).toBe(queued.jobId);
 await handler(claimed!);
 const jobs = await listJobs(dependencies.store);
 expect(jobs.filter((job) => job.type === "google-source-sync")).toHaveLength(2);
 expect(jobs.find((job) => job.id === queued.jobId)!.progress).toMatchObject({ googleCheckpointCommitted: true, complete: false });
 await dependencies.store.query("UPDATE brain_jobs SET status='pending',worker_id=NULL,lease_expires_at=NULL WHERE id=$1", [queued.jobId]);
 const handlers = { "google-source-sync": handler, projection: async () => { await indexBrainRepository(dependencies.store, dependencies.repository); } };
 for (let index = 0; index < 6; index++) await runOneJob(dependencies.store, "worker", handlers);
 expect(requests).toBe(2);
 expect(await dependencies.repository.listPages()).toHaveLength(2);
 const status = await googleSourceStatus(dependencies, owner);
 expect(status.sources[0]!.checkpoints).toBe(2);
 expect(JSON.stringify(await listJobs(dependencies.store))).not.toContain("private-access");
 expect(JSON.stringify(status)).not.toContain("finished");
}), 15000);
test("Google queue cancellation during a request prevents canonical persistence and checkpoint advancement", async () => fixture(async (dependencies) => {
 const source = await addGoogleSource(dependencies, owner, boundary);
 const queued = await enqueueGoogleSync(dependencies, owner, { id: source.id, expectedRevision: source.revision, idempotencyKey: "cancel" });
 const handler = googleSyncHandler({ ...dependencies, workerId: "worker", fetcher: async () => {
  await cancelJob(dependencies.store, queued.jobId);
  return Response.json({ connections: [{ resourceName: "people/private", metadata: {} }], nextSyncToken: "never-commit" });
 } });
 const result = await runOneJob(dependencies.store, "worker", { "google-source-sync": handler });
 expect(result!.status).toBe("cancelled");
 expect(await dependencies.repository.listPages()).toHaveLength(0);
 expect((await googleSourceStatus(dependencies, owner)).sources[0]!.checkpoints).toBe(0);
}), 15000);
test("Google queue page budgets expose incomplete scans without discarding their resumable cursor", async () => fixture(async (dependencies) => {
 const source = await addGoogleSource(dependencies, owner, boundary);
 const queued = await enqueueGoogleSync(dependencies, owner, { id: source.id, expectedRevision: source.revision, idempotencyKey: "bounded", maximumPages: 1 });
 const handler = googleSyncHandler({ ...dependencies, workerId: "worker", fetcher: async () => Response.json({ connections: [], nextPageToken: "resume-here" }) });
 await runOneJob(dependencies.store, "worker", { "google-source-sync": handler });
 const jobs = await listJobs(dependencies.store);
 expect(jobs.find((job) => job.id === queued.jobId)!.progress).toMatchObject({ complete: false, budgetExhausted: true });
 expect(jobs.filter((job) => job.type === "google-source-sync")).toHaveLength(1);
 expect((await dependencies.store.query<{ cursor: { pageToken: string } }>("SELECT cursor FROM brain_google_sources"))[0]!.cursor.pageToken).toBe("resume-here");
}), 15000);

test("Google catalog exposes owner-only source setup, status, and queued sync with the shared schema", async () => fixture(async (dependencies) => {
 const registry = createFullOperationRegistry({ repository: dependencies.repository, store: dependencies.store, googleCredentials: dependencies.credentials });
 expect(registry.get("google.sources.add")).toMatchObject({ requiredScope: "admin", trustBoundary: "local-only" });
 await expect(registry.execute({ scope: "write" }, "google.sources.add", { boundary })).rejects.toThrow("insufficient");
 await expect(registry.execute(owner, "google.sources.add", { boundary: { ...boundary, accessToken: "must-not-persist" } })).rejects.toThrow("unknown Google source boundary field");
 const source = await registry.execute(owner, "google.sources.add", { boundary }) as { id: string; revision: string };
 expect(await registry.execute(owner, "google.sources.status", {})).toMatchObject({ sources: [{ id: source.id, enabled: true }] });
 expect(await registry.execute({ ...owner, allowedAccessLabels: [] }, "google.sources.status", {})).toEqual({ sources: [] });
 await expect(registry.execute({ ...owner, brainId: "other-brain" }, "google.sources.status", {})).rejects.toThrow("owner_access_required");
 expect(await registry.execute(owner, "google.sources.sync", { id: source.id, expectedRevision: source.revision, idempotencyKey: "catalog" })).toMatchObject({ sourceId: source.id });
 expect(await registry.execute(owner, "google.sources.enable", { id: source.id, expectedRevision: source.revision, enabled: false, idempotencyKey: "catalog-disable" })).toMatchObject({ enabled: false, replayed: false });
}), 15000);

test("Google queue honors retry delays and stops permanent credential failures", async () => fixture(async (dependencies) => {
 const source = await addGoogleSource(dependencies, owner, boundary);
 const queued = await enqueueGoogleSync(dependencies, owner, { id: source.id, expectedRevision: source.revision, idempotencyKey: "retry" });
 const handler = googleSyncHandler({ ...dependencies, workerId: "worker", fetcher: async () => new Response("", { status: 429, headers: { "retry-after": "5" } }) });
 const started = Date.now();
 await expect(runOneJob(dependencies.store, "worker", { "google-source-sync": handler })).rejects.toMatchObject({ retryable: true, retryAfterMs: 5000 });
 const delayed = (await listJobs(dependencies.store)).find((job) => job.id === queued.jobId)!;
 expect(delayed.status).toBe("pending");
 expect(new Date(delayed.availableAt).getTime()).toBeGreaterThanOrEqual(started + 5000);
 await dependencies.store.query("UPDATE brain_jobs SET available_at=now() WHERE id=$1", [queued.jobId]);
 const denied = googleSyncHandler({ ...dependencies, workerId: "worker", fetcher: async () => new Response("", { status: 403 }) });
 await expect(runOneJob(dependencies.store, "worker", { "google-source-sync": denied })).rejects.toMatchObject({ retryable: false });
 expect((await listJobs(dependencies.store)).find((job) => job.id === queued.jobId)!.status).toBe("failed");
}), 15000);

test("Google source revocation cancels active work and a new revision prevents old jobs from reviving", async () => fixture(async (dependencies) => {
 const source = await addGoogleSource(dependencies, owner, boundary);
 const first = await enqueueGoogleSync(dependencies, owner, { id: source.id, expectedRevision: source.revision, idempotencyKey: "before-disable" });
 let currentRevision = "", disabledRevision = "";
 const disable = { id: source.id, expectedRevision: source.revision, enabled: false, idempotencyKey: "disable-once" };
 const handler = googleSyncHandler({ ...dependencies, workerId: "worker", fetcher: async () => {
  const stopped = await setGoogleSourceEnabled(dependencies, owner, disable);
  disabledRevision = stopped.revision;
  const restarted = await setGoogleSourceEnabled(dependencies, owner, { id: source.id, expectedRevision: stopped.revision, enabled: true, idempotencyKey: "enable-once" });
  currentRevision = restarted.revision;
  return Response.json({ connections: [{ resourceName: "people/stale", metadata: {} }], nextSyncToken: "must-not-commit" });
 } });
 expect((await runOneJob(dependencies.store, "worker", { "google-source-sync": handler }))!.status).toBe("cancelled");
 expect((await listJobs(dependencies.store)).find((job) => job.id === first.jobId)!.status).toBe("cancelled");
 expect(currentRevision).not.toBe(source.revision);
 expect(currentRevision).not.toBe(disabledRevision);
 expect(await dependencies.repository.listPages()).toHaveLength(0);
 expect((await googleSourceStatus(dependencies, owner)).sources[0]).toMatchObject({ enabled: true, revision: currentRevision, checkpoints: 0 });
 expect(await setGoogleSourceEnabled(dependencies, owner, disable)).toMatchObject({ enabled: false, revision: disabledRevision, replayed: true });
 expect((await googleSourceStatus(dependencies, owner)).sources[0]!.enabled).toBe(true);
 expect((await addGoogleSource(dependencies, owner, boundary)).revision).toBe(currentRevision);
 await expect(enqueueGoogleSync(dependencies, owner, { id: source.id, expectedRevision: source.revision, idempotencyKey: "old-revision" })).rejects.toMatchObject({ code: "source_unavailable_or_changed" });
 await enqueueGoogleSync(dependencies, owner, { id: source.id, expectedRevision: currentRevision, idempotencyKey: "after-enable" });
 const fresh = googleSyncHandler({ ...dependencies, workerId: "worker", fetcher: async () => Response.json({ connections: [{ resourceName: "people/current", metadata: {} }], nextSyncToken: "current" }) });
 expect((await runOneJob(dependencies.store, "worker", { "google-source-sync": fresh }))!.status).toBe("complete");
 expect(await dependencies.repository.listPages()).toHaveLength(1);
}), 15000);
test("Google source no-op enable preserves its lease and mutations reject stale revisions or changed idempotency input", async () => fixture(async (dependencies) => {
 const source = await addGoogleSource(dependencies, owner, boundary);
 await dependencies.store.query("UPDATE brain_google_sources SET worker_id='active-worker',lease_expires_at=now()+interval '60 seconds'");
 const input = { id: source.id, expectedRevision: source.revision, enabled: true, idempotencyKey: "already-enabled" };
 expect(await setGoogleSourceEnabled(dependencies, owner, input)).toMatchObject({ revision: source.revision, enabled: true });
 expect((await dependencies.store.query<{ worker_id: string }>("SELECT worker_id FROM brain_google_sources"))[0]!.worker_id).toBe("active-worker");
 await expect(setGoogleSourceEnabled(dependencies, owner, { ...input, enabled: false })).rejects.toMatchObject({ code: "idempotency_conflict" });
 await expect(setGoogleSourceEnabled(dependencies, owner, { ...input, idempotencyKey: "stale", expectedRevision: "stale" })).rejects.toMatchObject({ code: "source_unavailable_or_changed" });
 await expect(setGoogleSourceEnabled(dependencies, { ...owner, allowedAccessLabels: [] }, { ...input, idempotencyKey: "denied" })).rejects.toMatchObject({ code: "source_visibility_denied" });
}), 15000);

test("Google schedules coalesce missed work, preserve receipts, and stop on source revocation", async () => fixture(async (dependencies) => {
 const source = await addGoogleSource(dependencies, owner, boundary);
 const input = { id: source.id, expectedRevision: source.revision, intervalSeconds: 60, enabled: true, idempotencyKey: "schedule", maximumPages: 2, runImmediately: true };
 const scheduled = await scheduleGoogleSource(dependencies, owner, input);
 expect(await scheduleGoogleSource(dependencies, owner, input)).toMatchObject({ id: scheduled.id, nextRunAt: scheduled.nextRunAt, replayed: true });
 await expect(scheduleGoogleSource(dependencies, owner, { ...input, intervalSeconds: 120 })).rejects.toMatchObject({ code: "idempotency_conflict" });
 await dependencies.store.query("UPDATE brain_job_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE id=$1", [scheduled.id]);
 const now = new Date();
 const concurrent = await Promise.all([materializeDueSchedules(dependencies.store, "local", now), materializeDueSchedules(dependencies.store, "local", now)]);
 expect(concurrent.flat()).toHaveLength(1);
 expect(concurrent.flat()[0]!.payload).toMatchObject({ sourceId: source.id, revision: source.revision, maximumPages: 2, pageNumber: 1 });
 expect(concurrent.flat()[0]!.maxAttempts).toBe(8);
 const status = (await googleSourceStatus(dependencies, owner)).sources[0]!;
 expect(status.schedule).toMatchObject({ enabled: true, intervalSeconds: 60 });
 expect(new Date(status.schedule!.nextRunAt).getTime()).toBeGreaterThan(now.getTime());
 const later = new Date(now.getTime() + 120000);
 expect(await materializeDueSchedules(dependencies.store, "local", later)).toHaveLength(0); // Existing pending scan owns the next poll.
 expect((await listJobs(dependencies.store)).filter((job) => job.type === "google-source-sync")).toHaveLength(1);
 const disabled = await setGoogleSourceEnabled(dependencies, owner, { id: source.id, expectedRevision: source.revision, enabled: false, idempotencyKey: "stop-scheduled" });
 expect((await googleSourceStatus(dependencies, owner)).sources[0]!.schedule!.enabled).toBe(false);
 expect((await listJobs(dependencies.store))[0]!.status).toBe("cancelled");
 const enabled = await setGoogleSourceEnabled(dependencies, owner, { id: source.id, expectedRevision: disabled.revision, enabled: true, idempotencyKey: "resume-source" });
 expect((await googleSourceStatus(dependencies, owner)).sources[0]!.schedule!.enabled).toBe(false);
 await dependencies.store.query("UPDATE brain_job_schedules SET enabled=true,next_run_at=now() WHERE id=$1", [scheduled.id]);
 expect(await materializeDueSchedules(dependencies.store, "local")).toHaveLength(0); // Old revision cannot be resurrected by a stale schedule.
 expect((await googleSourceStatus(dependencies, owner)).sources[0]!.schedule!.enabled).toBe(false);
 const renewed = await scheduleGoogleSource(dependencies, owner, { ...input, expectedRevision: enabled.revision, idempotencyKey: "resume-schedule" });
 expect(renewed.revision).toBe(enabled.revision);
 expect((await materializeDueSchedules(dependencies.store, "local")).length).toBe(1);
}), 15000);
test("Google schedule configuration is owner-only and pausing its schedule preserves a running scan", async () => fixture(async (dependencies) => {
 const registry = createFullOperationRegistry({ repository: dependencies.repository, store: dependencies.store, googleCredentials: dependencies.credentials });
 const source = await addGoogleSource(dependencies, owner, boundary);
 const input = { id: source.id, expectedRevision: source.revision, intervalSeconds: 300, enabled: true, idempotencyKey: "catalog-schedule", runImmediately: true };
 await expect(registry.execute({ scope: "write" }, "google.sources.schedule", input)).rejects.toThrow("insufficient");
 await expect(registry.execute({ scope: "write" }, "jobs.enqueue", { type: "google-source-sync", payload: { brainId: "brain", sourceId: source.id, revision: source.revision, pageNumber: 1, maximumPages: 1 } })).rejects.toThrow("scope");
 await registry.execute(owner, "google.sources.schedule", input);
 const pending = await materializeDueSchedules(dependencies.store, "local");
 expect(pending).toHaveLength(1);
 await registry.execute(owner, "google.sources.schedule", { ...input, enabled: false, runImmediately: false, idempotencyKey: "pause" });
 expect((await listJobs(dependencies.store)).find((job) => job.id === pending[0]!.id)!.status).toBe("pending");
 expect((await googleSourceStatus(dependencies, owner)).sources[0]!.schedule!.enabled).toBe(false);
 await expect(scheduleGoogleSource(dependencies, owner, { ...input, intervalSeconds: 1, idempotencyKey: "too-frequent" })).rejects.toMatchObject({ code: "invalid_source_schedule" });
}), 15000);
