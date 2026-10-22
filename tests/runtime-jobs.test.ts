import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { defaultConfig } from "../src/config";
import { createBrainEngine } from "../src/engine";
import { createRuntimeJobHandlers } from "../src/brain/runtime-jobs";
import { enqueueJob, runOneJob, listJobs } from "../src/brain/jobs";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), "manas-runtime-jobs-")); roots.push(root);
 const config = defaultConfig({ MANAS_STATE: join(root, "state"), MANAS_ARCHIVE: join(root, "archive") });
 const engine = await createBrainEngine({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store") });
 execFileSync("git", ["-C", engine.repository.root, "config", "user.name", "Test"]);
 execFileSync("git", ["-C", engine.repository.root, "config", "user.email", "test@example.invalid"]);
 await engine.repository.putPage("notes/start.md", "Canonical evidence.");
 const handlers = createRuntimeJobHandlers({ store: engine.store!, repository: engine.repository, providers: engine.providers, config, workerId: "test-worker" });
 return { root, engine, handlers };
}
test("runtime jobs reject foreign repositories, tenants, brains, and managed source impersonation", async () => {
 const { root, engine, handlers } = await fixture();
 try {
  const head = await engine.repository.head();
  const foreign = join(root, "outside"); await symlink(root, foreign);
  for (const [type, payload, tenantId, code] of [
   ["index", { repositoryRoot: foreign }, "local", "job_repository_mismatch"],
   ["index", { brainId: "other" }, "local", "job_scope_mismatch"],
   ["index", {}, "other", "job_scope_mismatch"],
   ["source-synchronization", { sourceId: "manas-memory", documents: [] }, "local", "reserved_source"],
   ["source-synchronization", { sourceId: "google:account:gmail:hash", documents: [] }, "local", "reserved_source"],
  ] as const) {
   const job = await enqueueJob(engine.store!, { type, payload, tenantId });
   await expect(handlers[type]!(job)).rejects.toMatchObject({ code, retryable: false });
  }
  expect(await engine.repository.head()).toBe(head);
 } finally { await engine.close(); }
});
test("projection jobs use the configured repository object and accept only its realpath aliases", async () => {
 const { root, engine, handlers } = await fixture();
 try {
  let snapshots = 0;
  const snapshot = engine.repository.snapshot.bind(engine.repository);
  engine.repository.snapshot = async (...args) => { snapshots++; return snapshot(...args); };
  const alias = join(root, "brain-alias"); await symlink(engine.repository.root, alias);
  await enqueueJob(engine.store!, { type: "index", payload: { repositoryRoot: alias } });
  expect(await runOneJob(engine.store!, "test-worker", handlers)).toMatchObject({ status: "complete" });
  expect(snapshots).toBeGreaterThan(0);
  const brainId = (await engine.repository.getIdentity()).brainId;
  expect(await engine.store!.query("SELECT brain_id, git_commit FROM brain_active_projection_runs")).toMatchObject([{ brain_id: brainId, git_commit: await engine.repository.head() }]);
 } finally { await engine.close(); }
});
test("source jobs inherit canonical scope and schedule a projection for that same brain", async () => {
 const { engine, handlers } = await fixture();
 try {
  await enqueueJob(engine.store!, { type: "source-synchronization", payload: { sourceId: "fixture", documents: [{ externalId: "one", suggestedPath: "files/one.md", content: "Imported Juniper evidence.", deleted: false, provenance: { sourceType: "fixture", retrievedAt: "2026-10-21T00:00:00Z" } }] } });
  expect(await runOneJob(engine.store!, "test-worker", handlers)).toMatchObject({ status: "complete" });
  expect((await engine.repository.getPage("files/one.md"))?.content).toContain("Juniper evidence");
  expect(await runOneJob(engine.store!, "test-worker", handlers)).toMatchObject({ type: "projection", status: "complete" });
  const brainId = (await engine.repository.getIdentity()).brainId;
  expect(await engine.store!.query("SELECT brain_id FROM brain_ingestion_runs")).toMatchObject([{ brain_id: brainId }]);
 } finally { await engine.close(); }
});
test("restricted clients cannot schedule owner work, inspect job payloads, cancel it, or run the worker", async () => {
 const { engine } = await fixture();
 try {
  const restricted = { scope: "admin" as const, tenantId: "local", allowedAccessLabels: [] };
  for (const [operation, input] of [
   ["jobs.enqueue", { type: "index", payload: {} }],
   ["jobs.schedule", { type: "index", payload: {}, intervalSeconds: 60 }],
   ["jobs.list", {}], ["jobs.schedules", {}], ["jobs.cancel", { id: "job" }], ["jobs.run-one", {}],
  ] as const) await expect(engine.operations.execute(restricted, operation, input)).rejects.toMatchObject({ code: "owner_access_required" });
  await expect(engine.operations.execute({ scope: "write", tenantId: "local" }, "jobs.enqueue", { type: "index", payload: {} })).rejects.toMatchObject({ code: "insufficient_scope" });
  expect(await engine.store!.query("SELECT id FROM brain_jobs")).toEqual([]);
 } finally { await engine.close(); }
});

test("runtime maintenance aliases scan canonical content instead of echoing supplied findings", async () => {
 const { engine, handlers } = await fixture();
 try {
  await engine.repository.putPage("notes/second.md", "Canonical evidence.");
  await enqueueJob(engine.store!, { type: "dream-maintenance", payload: { findings: ["invented assertion"], facts: [{ subject: "forged", predicate: "owns", object: "everything" }] } });
  expect(await runOneJob(engine.store!, "test-worker", handlers)).toMatchObject({ status: "complete" });
  const listed = await engine.operations.execute({ scope: "admin" }, "maintenance.proposals", {});
  expect(listed).toMatchObject({ items: [{ kind: "duplicate" }] });
  expect(JSON.stringify(listed)).not.toContain("invented assertion");
  expect(await engine.store!.query("SELECT * FROM brain_facts")).toHaveLength(0);
  const page = (await engine.repository.snapshot()).pages.find((page) => page.source?.type === "manas-maintenance-proposal")!;
  await expect(engine.operations.execute({ scope: "admin" }, "put_page", { path: page.path, content: "erased", expectedHead: await engine.repository.head(), expectedRevision: page.revision })).rejects.toMatchObject({ code: "graph_lifecycle_required" });
 } finally { await engine.close(); }
});

test("runtime meeting preparation and reminder scans use current canonical evidence", async () => {
 const { engine, handlers } = await fixture();
 try {
  const fact = await engine.repository.putPage("notes/meeting.md", "Maya discussed the Juniper proposal.");
  await enqueueJob(engine.store!, { type: "meeting-preparation", payload: { title: "Juniper", participants: ["Maya"] } });
  const result = await runOneJob(engine.store!, "test-worker", handlers);
  expect(result).toMatchObject({ status: "complete" });
  const saved = (await listJobs(engine.store!)).find((job) => job.id === result!.id)!;
  expect(saved.progress).toMatchObject({ freshness: "current" });
  const id = saved.progress!.preparationId as string;
  const brief = await engine.operations.execute({ scope: "admin", principal: "owner" }, "meetings.get", { id });
  expect(brief).toMatchObject({ outcome: "prepared", recentInteractions: [{ documentId: fact.id }] });
  await enqueueJob(engine.store!, { type: "reminders", payload: { reminders: [{ title: "Untrusted supplied reminder" }] } });
  const scan = await runOneJob(engine.store!, "test-worker", handlers);
  expect(scan).toMatchObject({ status: "complete" });
  expect((await listJobs(engine.store!)).find((job) => job.id === scan!.id)?.progress).toMatchObject({ due: 0, notificationsEnabled: false });
  expect(await engine.store!.query("SELECT id FROM brain_admin_action_receipts WHERE action='open-loop-reminder'")).toEqual([]);
 } finally { await engine.close(); }
});
