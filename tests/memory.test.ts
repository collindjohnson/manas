import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { BrainRepository } from "../src/brain/repository";
import { remember, recall, correct, forget, memoryHistory } from "../src/brain/memory";
import { openPgliteBrainStore } from "../src/brain/store";
import { indexBrainRepository, indexBrainRepositoryIsolated, indexBrainRepositoryIncremental, searchVerifiedHybridBrainRepository } from "../src/brain/pglite-indexer";
import { createFullOperationRegistry } from "../src/brain/operation-catalog";
const execFile = promisify(execFileCallback);
const owner = { scope: "admin" as const, tenantId: "local", principal: "owner" };
async function fixture(run: (repository: BrainRepository, root: string) => Promise<void>) {
 const root = await mkdtemp(join(tmpdir(), "manas-memory-"));
 try {
  const repository = new BrainRepository(join(root, "brain"));
  await repository.initialize();
  await execFile("git", ["-C", repository.root, "config", "user.name", "Test"]);
  await execFile("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  await run(repository, root);
 } finally { await rm(root, { recursive: true, force: true }); }
}
const input = { text: "Telescope owner is Alice.", idempotencyKey: "first", provenance: { sourceType: "user", sessionId: "session", turnId: "turn" }, visibility: ["private"] };

test("memory writes survive reopen, deduplicate retries, and supersede assertions with revision checks", async () => fixture(async (repository) => {
 const first = await remember(repository, owner, input);
 const reopened = new BrainRepository(repository.root);
 expect(await remember(reopened, owner, input)).toMatchObject({ id: first.id, revision: first.revision, replayed: true });
 expect((await recall(reopened, { ...owner, allowedAccessLabels: [] }, { query: "Telescope" })).results).toEqual([]);
 expect((await recall(reopened, owner, { query: "Telescope" })).results[0]).toMatchObject({ id: first.id, text: input.text, visibility: ["private"], provenance: input.provenance });
 await expect(remember(reopened, owner, { ...input, text: "Different input" })).rejects.toMatchObject({ code: "idempotency_conflict" });
 const correctedInput = { id: first.id, expectedRevision: first.revision, idempotencyKey: "correction", text: "Telescope owner is Bob.", provenance: { sourceType: "user" } };
 const corrected = await correct(reopened, owner, correctedInput);
 expect(corrected.id).toBe(first.id);
 expect(corrected.revision).not.toBe(first.revision);
 expect((await recall(reopened, owner, { query: "Telescope" })).results[0]).toMatchObject({ text: correctedInput.text, supersedes: first.revision, visibility: ["private"] });
 await expect(correct(reopened, owner, { ...correctedInput, idempotencyKey: "stale" })).rejects.toMatchObject({ code: "revision_conflict" });
 expect((await memoryHistory(reopened, owner, first.id)).history.map((entry) => entry.text)).toEqual([correctedInput.text, input.text]);
}));

test("withdrawals suppress stale projections and every rebuild while owner history remains explicit", async () => fixture(async (repository) => {
 const store = await openPgliteBrainStore();
 try {
  const first = await remember(repository, owner, input);
  await indexBrainRepository(store, repository);
  expect(await searchVerifiedHybridBrainRepository(store, repository, "Telescope")).toHaveLength(1);
  const withdrawalInput = { id: first.id, expectedRevision: first.revision, idempotencyKey: "withdraw", reason: "Owner requested withdrawal" };
  const withdrawn = await forget(repository, owner, withdrawalInput);
  expect(withdrawn.status).toBe("withdrawn");
  expect((await recall(repository, owner, { query: "Telescope" })).results).toEqual([]);
  expect(await searchVerifiedHybridBrainRepository(store, repository, "Telescope")).toEqual([]);
  await indexBrainRepositoryIncremental(store, repository);
  expect(await searchVerifiedHybridBrainRepository(store, repository, "Telescope")).toEqual([]);
  const rebuilt = await openPgliteBrainStore();
  try {
   await indexBrainRepositoryIsolated(rebuilt, repository);
   expect(await searchVerifiedHybridBrainRepository(rebuilt, repository, "withdrawn")).toEqual([]);
   expect(await searchVerifiedHybridBrainRepository(rebuilt, repository, "Telescope")).toEqual([]);
  } finally { await rebuilt.close(); }
  await indexBrainRepository(store, repository);
  expect(await searchVerifiedHybridBrainRepository(store, repository, "Telescope")).toEqual([]);
  expect(await forget(repository, owner, withdrawalInput)).toMatchObject({ revision: withdrawn.revision, replayed: true });
  expect(await remember(repository, owner, input)).toMatchObject({ id: first.id, replayed: true });
  await expect(correct(repository, owner, { ...input, id: first.id, expectedRevision: withdrawn.revision, idempotencyKey: "reactivate" })).rejects.toMatchObject({ code: "memory_withdrawn" });
  const history = await memoryHistory(repository, owner, first.id);
  expect(history.history.at(-1)?.text).toBe(input.text);
  await expect(memoryHistory(repository, { ...owner, allowedAccessLabels: ["private"] }, first.id)).rejects.toMatchObject({ code: "unauthorized" });
 } finally { await store.close(); }
}));

test("memory validity and authorization are enforced without a projection", async () => fixture(async (repository) => {
 await remember(repository, owner, { ...input, validFrom: "2030-01-01T00:00:00Z", validUntil: "2031-01-01T00:00:00Z" });
 expect((await recall(repository, owner, { query: "Telescope", now: new Date("2029-01-01") })).results).toEqual([]);
 expect((await recall(repository, owner, { query: "Telescope", now: new Date("2030-06-01") })).results).toHaveLength(1);
 expect((await recall(repository, owner, { query: "Telescope", now: new Date("2031-01-01") })).results).toEqual([]);
 await expect(remember(repository, { ...owner, allowedAccessLabels: [] }, { ...input, idempotencyKey: "unauthorized" })).rejects.toMatchObject({ code: "unauthorized" });
 await expect(recall(repository, { ...owner, tenantId: "other" }, { query: "Telescope" })).rejects.toMatchObject({ code: "unauthorized" });
}));

test("catalog persists memory operations and makes corrected evidence immediately retrievable", async () => fixture(async (repository) => {
 const store = await openPgliteBrainStore();
 try {
  const registry = createFullOperationRegistry({ repository, store });
  const first = await registry.execute(owner, "memory.remember", input) as { id: string; revision: string };
  expect(await registry.execute(owner, "retrieval.search", { query: "Telescope" })).toMatchObject({ results: [{ verifiedText: input.text }] });
  const corrected = await registry.execute(owner, "memory.correct", { id: first.id, expectedRevision: first.revision, idempotencyKey: "correction", text: "Telescope owner is Bob.", provenance: { sourceType: "user" } }) as { revision: string };
  expect(await registry.execute(owner, "retrieval.search", { query: "Telescope" })).toMatchObject({ results: [{ verifiedText: "Telescope owner is Bob." }] });
  expect(await registry.execute(owner, "context.deliver", { query: "Telescope" })).toMatchObject({ outcome: "delivered", citations: [{ documentId: first.id }] });
  expect(await registry.execute({ ...owner, allowedAccessLabels: [] }, "context.deliver", { query: "Telescope" })).toMatchObject({ outcome: "empty", citations: [] });
  await forget(repository, owner, { id: first.id, expectedRevision: corrected.revision, idempotencyKey: "withdraw-before-projection" });
  expect(await registry.execute(owner, "context.deliver", { query: "Telescope" })).toMatchObject({ outcome: "empty", citations: [] });
 } finally { await store.close(); }
}));

test("memory receipts recover a committed write after response failure and deduplicate concurrent capture", async () => fixture(async (repository) => {
 let injected = false;
 const interrupted = new BrainRepository(repository.root, { faultInjector: (point) => { if (point === "post-commit-cleanup" && !injected) { injected = true; throw new Error("response lost"); } } });
 const result = await remember(interrupted, owner, input);
 expect(injected).toBe(true);
 expect(result.replayed).toBe(true);
 const concurrent = { ...input, idempotencyKey: "concurrent", text: "Juniper launch is Friday." };
 const captures = await Promise.all([remember(repository, owner, concurrent), remember(repository, owner, concurrent)]);
 expect(captures[0]?.id).toBe(captures[1]?.id);
 expect((await recall(repository, owner, { query: "Juniper" })).results).toHaveLength(1);
}));

test("generic page operations cannot reactivate or rewrite a memory", async () => fixture(async (repository) => {
 const first = await remember(repository, owner, input);
 const registry = createFullOperationRegistry({ repository });
 const entry = (await repository.snapshot()).pages.find((page) => page.id === first.id)!;
 await expect(registry.execute(owner, "put_page", { path: entry.path, content: "rewrite", expectedRevision: entry.revision, expectedHead: first.commit })).rejects.toMatchObject({ code: "memory_lifecycle_required" });
 await expect(repository.revertPage(entry.path, first.commit, entry.revision, first.commit)).rejects.toThrow("memory lifecycle");
 await forget(repository, owner, { id: first.id, expectedRevision: first.revision, idempotencyKey: "forget" });
 await expect(registry.execute(owner, "get_page", { path: entry.path })).rejects.toMatchObject({ code: "memory_unavailable" });
 expect(await registry.execute(owner, "list_pages", {})).toMatchObject({ pages: [] });
 expect(await registry.execute(owner, "export_brain", { ref: first.commit })).toMatchObject({ pages: [] });
}));

test("correction and withdrawal invalidate derived facts and answer caches", async () => fixture(async (repository) => {
 const { recordFact, recordClaim, setScopedCache } = await import("../src/brain/analytics");
 const store = await openPgliteBrainStore();
 try {
  const first = await remember(repository, owner, input);
  await indexBrainRepository(store, repository);
  const brainId = (await repository.getIdentity()).brainId;
  const fact = await recordFact(store, { tenantId: "local", brainId, documentId: first.id, subject: "Telescope", predicate: "owner", objectValue: "Alice", confidence: 1 });
  await recordClaim(store, { tenantId: "local", brainId, factId: fact.id, claim: "Alice owns Telescope", status: "active", confidence: 1 });
  await setScopedCache(store, { tenantId: "local", brainId, cacheKey: "answer", projectedCommit: first.commit, schemaVersion: "1", modelFingerprint: "local", value: "Alice" });
  await correct(repository, owner, { ...input, id: first.id, expectedRevision: first.revision, idempotencyKey: "correct", text: "Telescope owner is Bob." });
  await indexBrainRepository(store, repository);
  expect(await store.query("SELECT id FROM brain_facts")).toEqual([]);
  expect(await store.query("SELECT id FROM brain_claims")).toEqual([]);
  expect(await store.query("SELECT id FROM brain_cache_entries")).toEqual([]);
 } finally { await store.close(); }
}));

test("receipt capacity never prevents a final withdrawal", async () => fixture(async (repository) => {
 const first = await remember(repository, owner, input);
 const snapshot = await repository.snapshot();
 const entry = snapshot.pages.find((page) => page.id === first.id)!;
 const metadata = { ...entry.source!.provenance!.metadata };
 for (let index = 0; index < 999; index++) metadata["memory.receipt.fixture-" + index] = JSON.stringify({ requestHash: "fixture", revision: first.revision, status: "active" });
 await repository.putPage(entry.path, input.text, entry.revision, { ...entry.source!, provenance: { ...entry.source!.provenance!, metadata } }, snapshot.commit);
 await expect(correct(repository, owner, { ...input, id: first.id, expectedRevision: first.revision, idempotencyKey: "over-capacity" })).rejects.toMatchObject({ code: "memory_capacity" });
 expect(await forget(repository, owner, { id: first.id, expectedRevision: first.revision, idempotencyKey: "final-withdrawal" })).toMatchObject({ status: "withdrawn" });
}));
