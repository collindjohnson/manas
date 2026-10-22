import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { BrainRepository } from "../src/brain/repository";
import { openPgliteBrainStore } from "../src/brain/store";
import { ingestConversation } from "../src/brain/conversation-ingestion";
import { createBrainEngine } from "../src/engine";
import { defaultConfig } from "../src/config";
import { renderNewDocument } from "../src/archive";
import { uuidv5 } from "../src/utils";
import { runSync } from "../src/sync";
import type { Conversation } from "../src/model";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const owner = { scope: "admin" as const, tenantId: "local" };
const conversation: Conversation = { provider: "codex", sourceId: "session-one", sourcePath: "/fixture/session.jsonl", title: "Juniper decision", fingerprint: "first", redactions: 0, updatedAt: "2020-01-01T00:00:00Z", messages: [{ role: "user", text: "Juniper owner is Maya." }] };
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), "manas-conversation-ingestion-")); roots.push(root);
 const repository = new BrainRepository(join(root, "brain")); await repository.initialize();
 execFileSync("git", ["-C", repository.root, "config", "user.name", "Test"]);
 execFileSync("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
 await repository.putPage("notes/start.md", "Initial canonical brain.");
 const store = await openPgliteBrainStore();
 return { root, repository, store };
}
test("canonical conversations retain archive IDs, update at equal timestamps, preserve notes, and replay durably", async () => {
 const dependencies = await fixture();
 try {
  const preview = await ingestConversation(dependencies, owner, { conversation, dryRun: true });
  expect(preview.action).toBe("create"); expect((await dependencies.repository.listPages()).length).toBe(1);
  expect(await dependencies.store.query("SELECT id FROM brain_ingestion_runs")).toEqual([]);
  const first = await ingestConversation(dependencies, owner, { conversation });
  expect(first.documentId).toBe(uuidv5("codex:session-one"));
  const page = await dependencies.repository.getPage(first.path);
  await dependencies.repository.putPage(first.path, page!.content + "\nPersonal annotation\n", page!.revision);
  const changed = { ...conversation, fingerprint: "second", messages: [{ role: "user" as const, text: "Juniper owner is Ellis." }] };
  const updated = await ingestConversation(dependencies, owner, { conversation: changed });
  expect(updated).toMatchObject({ action: "update", documentId: first.documentId, path: first.path });
  expect((await dependencies.repository.getPage(first.path))!.content).toContain("Personal annotation");
  expect((await dependencies.repository.getPage(first.path))!.content).toContain("owner is Ellis");
  const head = await dependencies.repository.head();
  expect(await ingestConversation(dependencies, owner, { conversation })).toMatchObject({ replayed: true });
  expect(await dependencies.repository.head()).toBe(head);
  expect((await dependencies.repository.getPage(first.path))!.content).toContain("owner is Ellis");
 } finally { await dependencies.store.close(); }
});
test("migration adoption retains nonstandard archive identity, path, visibility, frontmatter and all user edits", async () => {
 const dependencies = await fixture();
 try {
  const legacy = renderNewDocument(conversation);
  const id = "aabbeeff-1234-5678-9abc-012345678901";
  const content = legacy.content.replace(legacy.id, id) + "\nOwner edited original transcript here.\n";
  const imported = await dependencies.repository.putPage("archive/custom.md", content, undefined, { type: "legacy-archive", externalId: id, visibilityLabels: ["private"] }, undefined, id);
  const changed = { ...conversation, fingerprint: "changed", messages: [{ role: "assistant" as const, text: "A later session update." }] };
  const result = await ingestConversation(dependencies, owner, { conversation: changed });
  expect(result).toMatchObject({ action: "update", documentId: id, path: "archive/custom.md", preservedLegacyContent: true });
  const updated = (await dependencies.repository.getPage(imported.path))!;
  expect(updated.content).toContain("Owner edited original transcript here.");
  expect(updated.content).toContain("A later session update.");
  expect(updated.content).toContain(id);
  expect(updated.accessLabels).toEqual(["private"]);
 } finally { await dependencies.store.close(); }
});
test("managed transcript edits stop ingestion without overwriting user work", async () => {
 const dependencies = await fixture();
 try {
  const result = await ingestConversation(dependencies, owner, { conversation });
  const page = (await dependencies.repository.getPage(result.path))!;
  await dependencies.repository.putPage(page.path, page.content.replace("owner is Maya", "owner edited this"), page.revision);
  const head = await dependencies.repository.head();
  await expect(ingestConversation(dependencies, owner, { conversation: { ...conversation, fingerprint: "changed" } })).rejects.toMatchObject({ code: "conversation_user_edit_conflict", retryable: false });
  expect(await dependencies.repository.head()).toBe(head);
 } finally { await dependencies.store.close(); }
});
test("interruption after Git commit resumes projection and receipt without a second write", async () => {
 const dependencies = await fixture();
 try {
  const abort = new AbortController();
  const put = dependencies.repository.putPage.bind(dependencies.repository);
  dependencies.repository.putPage = async (...args) => { const result = await put(...args); abort.abort(); return result; };
  await expect(ingestConversation(dependencies, { ...owner, signal: abort.signal }, { conversation })).rejects.toThrow();
  const head = await dependencies.repository.head();
  expect(await dependencies.store.query("SELECT status FROM brain_ingestion_runs")).toMatchObject([{ status: "running" }]);
  dependencies.repository.putPage = put;
  expect(await ingestConversation(dependencies, owner, { conversation })).toMatchObject({ replayed: true, documentId: uuidv5("codex:session-one") });
  expect(await dependencies.repository.head()).toBe(head);
  expect(await dependencies.store.query("SELECT status FROM brain_ingestion_runs")).toMatchObject([{ status: "complete" }]);
 } finally { await dependencies.store.close(); }
});
test("ingestion rejects restricted clients, wrong tenants, marker injection, and ID collisions", async () => {
 const dependencies = await fixture();
 try {
  await expect(ingestConversation(dependencies, { ...owner, allowedAccessLabels: [] }, { conversation })).rejects.toMatchObject({ code: "owner_access_required" });
  await expect(ingestConversation(dependencies, { ...owner, tenantId: "other" }, { conversation })).rejects.toMatchObject({ code: "unauthorized" });
  await expect(ingestConversation(dependencies, owner, { conversation: { ...conversation, messages: [{ role: "user", text: "<!-- manas:conversation:end -->" }] } })).rejects.toMatchObject({ code: "invalid_conversation" });
  const rendered = renderNewDocument(conversation);
  await dependencies.repository.putPage("notes/collision.md", "Unrelated owner work.", undefined, undefined, undefined, rendered.id);
  await expect(ingestConversation(dependencies, owner, { conversation })).rejects.toMatchObject({ code: "conversation_identity_conflict" });
 } finally { await dependencies.store.close(); }
});
test("configured sync uses the canonical registry and leaves the legacy archive untouched", async () => {
 const dependencies = await fixture(); await dependencies.store.close();
 const stateRoot = join(dependencies.root, "state"), archiveRoot = join(dependencies.root, "archive");
 await mkdir(stateRoot); await mkdir(archiveRoot); await writeFile(join(archiveRoot, "sentinel.txt"), "legacy remains");
 const config = defaultConfig({ MANAS_STATE: stateRoot, MANAS_ARCHIVE: archiveRoot });
 await writeFile(join(stateRoot, "canonical-runtime.json"), JSON.stringify({ version: 1, mode: "canonical", migrationId: "fixture", repositoryRoot: dependencies.repository.root, storePath: join(stateRoot, "runtime"), baseCommit: await dependencies.repository.head(), selectedAt: new Date().toISOString() }));
 const result = await runSync(config, { conversations: [conversation] });
 expect(result.report.totals).toMatchObject({ created: 1, failures: 0 });
 expect(await readFile(join(archiveRoot, "sentinel.txt"), "utf8")).toBe("legacy remains");
 const page = await dependencies.repository.getPage(result.changes[0]!.relativePath!);
 expect(page?.id).toBe(uuidv5("codex:session-one"));
 const again = await runSync(config, { conversations: [conversation] });
 expect(again.report.totals).toMatchObject({ skipped: 1, created: 0, failures: 0 });
 const engine = await createBrainEngine({ config, repositoryRoot: dependencies.repository.root, storePath: join(stateRoot, "runtime") });
 try {
  const result = await engine.operations.execute({ scope: "read", tenantId: "local" }, "retrieval.search", { query: "Juniper owner", options: { mode: "keyword" } }) as { results: Array<{ citation: { documentId: string }; verifiedText: string }> };
  expect(result.results.some((item) => item.citation.documentId === page!.id && item.verifiedText.includes("Maya"))).toBe(true);
  await expect(engine.operations.execute({ scope: "write" }, "sources.conversation.ingest", { conversation })).rejects.toThrow("scope");
 } finally { await engine.close(); }
});

test("a staged ingestion can resume after unrelated commits but never overwrite a later source revision", async () => {
 const dependencies = await fixture();
 try {
  const put = dependencies.repository.putPage.bind(dependencies.repository);
  dependencies.repository.putPage = async () => { throw new Error("simulated write failure"); };
  await expect(ingestConversation(dependencies, owner, { conversation })).rejects.toThrow("simulated");
  dependencies.repository.putPage = put;
  await dependencies.repository.putPage("notes/unrelated.md", "Unrelated owner edit.");
  expect(await ingestConversation(dependencies, owner, { conversation })).toMatchObject({ replayed: true, action: "create" });
  const page = (await dependencies.repository.getPage(renderNewDocument(conversation).relativePath))!;
  const changed = { ...conversation, fingerprint: "pending", messages: [{ role: "assistant" as const, text: "Pending update." }] };
  dependencies.repository.putPage = async () => { throw new Error("simulated update failure"); };
  await expect(ingestConversation(dependencies, owner, { conversation: changed })).rejects.toThrow("simulated");
  dependencies.repository.putPage = put;
  await dependencies.repository.putPage(page.path, page.content + "\nLater notes\n", page.revision);
  expect(await ingestConversation(dependencies, owner, { conversation: changed })).toMatchObject({ action: "update" });
  expect((await dependencies.repository.getPage(page.path))!.content).toContain("Later notes");
  const blocked = { ...changed, fingerprint: "older-pending" };
  dependencies.repository.putPage = async () => { throw new Error("simulated update failure"); };
  await expect(ingestConversation(dependencies, owner, { conversation: blocked })).rejects.toThrow("simulated");
  dependencies.repository.putPage = put;
  await ingestConversation(dependencies, owner, { conversation: { ...changed, fingerprint: "newer", messages: [{ role: "user", text: "Newest source revision." }] } });
  await expect(ingestConversation(dependencies, owner, { conversation: blocked })).rejects.toMatchObject({ code: "conversation_revision_conflict" });
  expect(await dependencies.store.query("SELECT reason FROM brain_source_failures WHERE reason = 'conversation_revision_conflict'")).toHaveLength(1);
 } finally { await dependencies.store.close(); }
});
test("concurrent duplicate ingestion creates one canonical ID and converges on a durable receipt", async () => {
 const dependencies = await fixture();
 try {
  const outcomes = await Promise.allSettled([ingestConversation(dependencies, owner, { conversation }), ingestConversation(dependencies, owner, { conversation })]);
  expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
  expect((await dependencies.repository.listPages()).filter((page) => page.id === uuidv5("codex:session-one"))).toHaveLength(1);
  expect(await ingestConversation(dependencies, owner, { conversation })).toMatchObject({ replayed: true });
  expect(await dependencies.store.query("SELECT id FROM brain_ingestion_runs WHERE status = 'complete'")).toHaveLength(1);
 } finally { await dependencies.store.close(); }
});
test("canonical sync shares the live service owner and returns searchable verified evidence", async () => {
 const { startLocalService, callLocalService } = await import("../src/local-service");
 const root = await mkdtemp(join(tmpdir(), "manas-conversation-service-")); roots.push(root);
 const config = defaultConfig({ MANAS_STATE: join(root, "state"), MANAS_ARCHIVE: join(root, "legacy") });
 const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store") });
 try {
  const repository = service.engine.repository;
  execFileSync("git", ["-C", repository.root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  await repository.putPage("notes/start.md", "Canonical brain.");
  await writeFile(join(config.stateRoot, "canonical-runtime.json"), JSON.stringify({ version: 1, mode: "canonical", migrationId: "fixture", repositoryRoot: repository.root, storePath: join(root, "store"), baseCommit: await repository.head(), selectedAt: new Date().toISOString() }));
  const result = await runSync(config, { conversations: [conversation] });
  expect(result.report.totals).toMatchObject({ created: 1, failures: 0 });
  const evidence = await callLocalService(config, "retrieval.search", { query: "Juniper owner", options: { mode: "keyword" } }) as { results: Array<{ citation: { documentId: string } }> };
  expect(evidence.results.some((item) => item.citation.documentId === uuidv5("codex:session-one"))).toBe(true);
  expect(await service.engine.store!.query("SELECT status FROM brain_ingestion_runs")).toMatchObject([{ status: "complete" }]);
 } finally { await service.close(); }
}, 15000);

test("legacy identity lookup reuses unchanged revisions and rechecks changed duplicate identities", async () => {
 const dependencies = await fixture();
 const repository = dependencies.repository;
 try {
  const legacy = renderNewDocument(conversation);
  const page = await repository.putPage("archive/old.md", legacy.content, undefined, { type: "legacy-archive", externalId: "old" });
  const read = repository.readPage.bind(repository);
  let legacyReads = 0;
  repository.readPage = async (snapshot, id) => { if (id === page.id) legacyReads++; return read(snapshot, id); };
  const incoming = { ...conversation, sourceId: "new-session" };
  await ingestConversation(dependencies, owner, { conversation: incoming, dryRun: true });
  expect(legacyReads).toBe(1);
  await repository.putPage("notes/unrelated.md", "Unrelated update");
  await ingestConversation(dependencies, owner, { conversation: incoming, dryRun: true });
  expect(legacyReads).toBe(1);
  const changed = renderNewDocument(incoming);
  await repository.putPage(page.path, changed.content, page.revision, page.source);
  const matched = await ingestConversation(dependencies, owner, { conversation: incoming, dryRun: true });
  expect(matched.documentId).toBe(page.id);
  expect(legacyReads).toBe(3);
  await repository.putPage("archive/duplicate.md", changed.content, undefined, { type: "legacy-archive", externalId: "duplicate" });
  await expect(ingestConversation(dependencies, owner, { conversation: incoming, dryRun: true })).rejects.toMatchObject({ code: "conversation_identity_conflict" });
 } finally { await dependencies.store.close(); }
});
