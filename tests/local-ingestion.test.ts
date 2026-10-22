import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import { BrainRepository } from "../src/brain/repository";
import { openPgliteBrainStore, type BrainStore } from "../src/brain/store";
import { createFullOperationRegistry } from "../src/brain/operation-catalog";
import { FilesystemSourceAdapter } from "../src/sources/filesystem";
import { syncSource } from "../src/sources/sync";
const execFile = promisify(callback);
const owner = { scope: "admin" as const, principal: "owner", tenantId: "local" };
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), "local-ingestion-"));
 const repository = new BrainRepository(join(root, "brain"));
 await repository.initialize();
 await execFile("git", ["-C", repository.root, "config", "user.name", "Test"]);
 await execFile("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
 const store = await openPgliteBrainStore(join(root, "store"));
 const source = join(root, "source");
 await mkdir(source);
 return { root, repository, store, source };
}
test("local sources retain IDs, durable fingerprint cursors and Notes across retries and late records", async () => {
 const f = await fixture();
 let store = f.store;
 try {
  const file = join(f.source, "fact.md");
  await writeFile(file, "Astral ownership belongs to Morgan.");
  // Simulate an older CLI record whose adapter root was spelled with /.
  await syncSource(new FilesystemSourceAdapter(f.source + "/"), f.repository);
  const prior = (await f.repository.listPages())[0]!;
  const current = await f.repository.getPage(prior.path);
  await f.repository.putPage(prior.path, current!.content + "Owner note stays.\n", prior.revision);
  const input = { path: f.source };
  let registry = createFullOperationRegistry({ repository: f.repository, store });
  expect(await registry.execute(owner, "sources.filesystem.sync", input)).toMatchObject({ created: 0 });
  expect((await f.repository.listPages())[0]!.id).toBe(prior.id);
  expect((await f.repository.getPage(prior.path))!.content).toContain("Owner note stays.");
  const head = await f.repository.head();
  const repeated = await Promise.all([registry.execute(owner, "sources.filesystem.sync", input), registry.execute(owner, "sources.filesystem.sync", input)]);
  expect(repeated).toEqual([{ created: 0, updated: 0, stale: 0, quarantined: 0 }, { created: 0, updated: 0, stale: 0, quarantined: 0 }]);
  expect(await f.repository.head()).toBe(head);
  await store.close();
  store = await openPgliteBrainStore(join(f.root, "store"));
  registry = createFullOperationRegistry({ repository: f.repository, store });
  const legacyRelative = (await f.repository.listPages()).find((page) => page.id === prior.id)!;
  const legacyPage = (await f.repository.getPage(legacyRelative.path))!;
  await f.repository.putPage(legacyRelative.path, legacyPage.content, legacyRelative.revision, { ...legacyRelative.source!, provenance: { ...legacyRelative.source!.provenance!, sourcePath: "old-working-directory/fact.md" } });
  await writeFile(file, "Astral ownership belongs to Taylor.");
  await utimes(file, new Date("2020-01-01"), new Date("2020-01-01"));
  await writeFile(join(f.source, "late.md"), "Delayed discovery from another session.");
  expect(await registry.execute(owner, "sources.filesystem.sync", input)).toMatchObject({ updated: 1, created: 1 });
  expect((await f.repository.listPages()).find((page) => page.id === prior.id)?.path).toBe(prior.path);
  expect(await registry.execute(owner, "retrieval.search", { query: "Taylor", options: { mode: "keyword" } })).toMatchObject({ results: [{ verifiedText: expect.stringContaining("Taylor") }] });
  const receipts = await store.query<{ status: string }>("SELECT status FROM brain_ingestion_runs");
  expect(receipts.every((row) => row.status === "complete")).toBe(true);
 } finally { await store.close(); await rm(f.root, { recursive: true, force: true }); }
});
test("local ingestion resumes a Git commit before checkpoint failure without a duplicate or lost input", async () => {
 const f = await fixture();
 try {
  await writeFile(join(f.source, "fact.md"), "Recovery evidence persists.");
  let failCheckpoint = true;
  const interrupted: BrainStore = {
   query: async (sql, parameters) => {
    if (failCheckpoint && sql.startsWith("UPDATE brain_operational_state SET value=")) { failCheckpoint = false; throw new Error("injected checkpoint interruption"); }
    return f.store.query(sql, parameters);
   },
   transaction: (action) => f.store.transaction(action), exec: (sql) => f.store.exec(sql), close: async () => {},
  };
  const registry = createFullOperationRegistry({ repository: f.repository, store: interrupted });
  await expect(registry.execute(owner, "sources.filesystem.sync", { path: f.source })).rejects.toThrow("checkpoint interruption");
  const page = (await f.repository.listPages())[0]!;
  const head = await f.repository.head();
  expect(await f.store.query("SELECT reason FROM brain_source_failures")).toMatchObject([{ reason: "injected checkpoint interruption" }]);
  await f.store.query("INSERT INTO brain_ingestion_runs (id,tenant_id,brain_id,source_id,status) VALUES ('interrupted-run','local',$1,'filesystem','running')", [(await f.repository.getIdentity()).brainId]);
  expect(await registry.execute(owner, "sources.filesystem.sync", { path: f.source })).toMatchObject({ created: 0, updated: 0 });
  expect(await f.store.query("SELECT reason FROM brain_source_failures WHERE ingestion_run_id='interrupted-run'")).toEqual([{ reason: "interrupted_ingestion" }]);

  expect(await f.repository.head()).toBe(head);
  expect((await f.repository.listPages())[0]!.id).toBe(page.id);
 } finally { await f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
test("imports are additive deliveries and local ingestion rejects restricted owners and changed boundaries", async () => {
 const f = await fixture();
 try {
  const registry = createFullOperationRegistry({ repository: f.repository, store: f.store });
  const first = join(f.root, "one.eml"), second = join(f.root, "two.eml");
  await writeFile(first, "Message-ID: one\nSubject: first\n\nFirst evidence.");
  await writeFile(second, "Message-ID: two\nSubject: second\n\nSecond evidence.");
  for (const path of [first, second]) expect(await registry.execute(owner, "sources.local.import", { path, format: "eml" })).toMatchObject({ created: 1, imported: 1 });
  expect((await f.repository.listPages()).every((page) => !page.stale)).toBe(true);
  expect(await registry.execute(owner, "sources.local.import", { path: first, format: "eml" })).toMatchObject({ created: 0, updated: 0 });
  await expect(registry.execute({ ...owner, allowedAccessLabels: [] }, "notes.capture", { content: "denied" })).rejects.toMatchObject({ code: "owner_access_required" });
  await expect(registry.execute({ ...owner, tenantId: "other" }, "sources.filesystem.sync", { path: f.source })).rejects.toMatchObject({ code: "owner_access_required" });
  await expect(registry.execute(owner, "sources.filesystem.sync", { path: f.source, sourceId: "manas-memory" })).rejects.toMatchObject({ code: "reserved_source" });
  await expect(registry.execute(owner, "sources.filesystem.sync", { path: f.repository.root })).rejects.toMatchObject({ code: "source_overlaps_brain" });
  await registry.execute(owner, "sources.filesystem.sync", { path: f.source });
  const other = join(f.root, "other");
  await mkdir(other);
  await expect(registry.execute(owner, "sources.filesystem.sync", { path: other })).rejects.toMatchObject({ code: "source_binding_conflict" });
 } finally { await f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
