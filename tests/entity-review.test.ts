import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { BrainRepository } from "../src/brain/repository";
import { openPgliteBrainStore } from "../src/brain/store";
import { indexBrainRepository, searchVerifiedHybridBrainRepository } from "../src/brain/pglite-indexer";
import { putEntity, putRelationship, resolveEntity, queryRelationships, entityReviews, resolveEntityReview } from "../src/brain/entity-relationships";
import { createFullOperationRegistry } from "../src/brain/operation-catalog";
import { remember, forget } from "../src/brain/memory";
const owner = { scope: "admin" as const, principal: "owner" };
async function fixture(run: (input: { repository: BrainRepository; store: Awaited<ReturnType<typeof openPgliteBrainStore>>; memory: Awaited<ReturnType<typeof remember>>; common: { evidence: Awaited<ReturnType<typeof searchVerifiedHybridBrainRepository>>[number]["citation"][]; confidence: number; entityType: string; aliases: string[] } }) => Promise<void>) {
 const root = await mkdtemp(join(tmpdir(), "manas-entity-review-")), repository = new BrainRepository(join(root, "brain")), store = await openPgliteBrainStore();
 try {
  await repository.initialize();
  const git = promisify(execFile);
  await git("git", ["-C", repository.root, "config", "user.name", "Test"]);
  await git("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  const memory = await remember(repository, owner, { text: "Alice, Ally and Old Alice refer to the same person. Alice works on Juniper.", provenance: { sourceType: "user" }, idempotencyKey: "evidence" });
  await indexBrainRepository(store, repository);
  const common = { evidence: (await searchVerifiedHybridBrainRepository(store, repository, "Alice")).map((hit) => hit.citation), confidence: 0.9, entityType: "person", aliases: [] as string[] };
  await run({ repository, store, memory, common });
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}
test("owner merge decisions resume after intent and target commits without duplicate entity writes", async () => fixture(async ({ repository, common }) => {
 const target = await putEntity(repository, owner, { ...common, name: "Alice", idempotencyKey: "alice" });
 if (target.needsReview) throw new Error("unexpected review");
 for (const phase of ["after-intent", "after-target"] as const) {
  const alias = "Ally-" + phase;
  const proposalInput = { ...common, name: alias, aliases: ["Alice"], visibility: ["private"], idempotencyKey: phase };
  const proposed = await putEntity(repository, owner, proposalInput);
  if (!proposed.needsReview) throw new Error("expected review");
  const input = { id: proposed.review.id, expectedRevision: proposed.review.revision, idempotencyKey: "owner-" + phase, decision: "merge" as const, targetId: target.id };
  await expect(resolveEntityReview(repository, owner, input, { faultInjector: async (point) => { if (point === phase) throw new Error("simulated crash"); } })).rejects.toThrow("simulated crash");
  expect((await entityReviews(repository, owner)).reviews.some((review) => review.status === "applying")).toBe(true);
  const before = (await repository.snapshot()).pages.find((page) => page.id === target.id)!.revision;
  const result = await resolveEntityReview(new BrainRepository(repository.root), owner, input);
  expect(result).toMatchObject({ status: "accepted", targetId: target.id, replayed: false });
  if (phase === "after-target") expect(result.targetRevision).toBe(before);
  expect(await resolveEntityReview(repository, owner, input)).toMatchObject({ status: "accepted", replayed: true });
  expect(await putEntity(repository, owner, proposalInput)).toMatchObject({ needsReview: true, review: { id: proposed.review.id, replayed: true } });
  await expect(putEntity(repository, owner, { ...proposalInput, name: "Changed proposal" })).rejects.toThrow("idempotency conflict");
  expect((await resolveEntity(repository, owner, alias)).entities[0]?.id).toBe(target.id);
  expect((await resolveEntity(repository, { scope: "read", allowedAccessLabels: [] }, alias)).entities).toEqual([]);
  await expect(resolveEntityReview(repository, owner, { ...input, decision: "reject", targetId: undefined })).rejects.toMatchObject({ code: "review_resolution_conflict" });
 }
}), 20000);
test("merging existing entities preserves stable IDs and redirects cited relationships after a crash", async () => fixture(async ({ repository, store, memory, common }) => {
 const original = await putEntity(repository, owner, { ...common, name: "Old Alice", aliases: ["Old"], idempotencyKey: "old" });
 const target = await putEntity(repository, owner, { ...common, name: "Alice", aliases: ["Ally"], idempotencyKey: "target" });
 const project = await putEntity(repository, owner, { ...common, name: "Juniper", entityType: "project", idempotencyKey: "project" });
 if (original.needsReview || target.needsReview || project.needsReview) throw new Error("unexpected review");
 const edge = await putRelationship(repository, owner, { ...common, fromId: original.id, toId: project.id, relationshipType: "works-on", idempotencyKey: "work" });
 const proposed = await putEntity(repository, owner, { ...common, id: original.id, expectedRevision: original.revision, name: "Old Alice", aliases: ["Alice"], idempotencyKey: "update" });
 if (!proposed.needsReview) throw new Error("expected review");
 const input = { id: proposed.review.id, expectedRevision: proposed.review.revision, idempotencyKey: "merge-existing", decision: "merge" as const, targetId: target.id };
 await expect(resolveEntityReview(repository, owner, input, { faultInjector: async (point) => { if (point === "after-redirect") throw new Error("crash after redirect"); } })).rejects.toThrow("crash after redirect");
 expect(await resolveEntityReview(new BrainRepository(repository.root), owner, input)).toMatchObject({ status: "accepted", targetId: target.id });
 expect((await resolveEntity(repository, owner, original.id)).entities[0]?.id).toBe(target.id);
 const result = await queryRelationships(repository, owner, { from: original.id, to: "Juniper" });
 expect(result.results).toHaveLength(1);
 expect(result.results[0]?.chain[0]).toMatchObject({ id: edge.id, fromId: target.id, redirects: [{ id: original.id, reviewId: proposed.review.id, targetId: target.id }] });
 expect((await resolveEntity(repository, owner, "Old")).entities[0]?.id).toBe(target.id);
 const redirected = (await repository.snapshot()).pages.find((page) => page.id === original.id)!;
 await expect(putEntity(repository, owner, { ...common, id: original.id, expectedRevision: redirected.revision, name: "Old Alice", idempotencyKey: "undo-without-review" })).rejects.toMatchObject({ code: "merged_entity" });
 await forget(repository, owner, { id: memory.id, expectedRevision: memory.revision, idempotencyKey: "withdraw" });
 await indexBrainRepository(store, repository);
 expect((await queryRelationships(repository, owner, { from: "Alice", to: "Juniper" })).results).toEqual([]);
 expect((await resolveEntity(repository, owner, original.id)).entities).toEqual([]);
}), 15000);
test("review rejection and owner authorization are durable and graph mutations cannot bypass review", async () => fixture(async ({ repository, common }) => {
 const target = await putEntity(repository, owner, { ...common, name: "Alice", idempotencyKey: "alice" });
 if (target.needsReview) throw new Error("unexpected review");
 const proposed = await putEntity(repository, owner, { ...common, name: "Ally", aliases: ["Alice"], idempotencyKey: "proposal" });
 if (!proposed.needsReview) throw new Error("expected review");
 const input = { id: proposed.review.id, expectedRevision: proposed.review.revision, idempotencyKey: "reject", decision: "reject" as const };
 await expect(resolveEntityReview(repository, { scope: "write" }, input)).rejects.toMatchObject({ code: "owner_required" });
 await expect(resolveEntityReview(repository, { ...owner, allowedAccessLabels: [] }, input)).rejects.toMatchObject({ code: "owner_required" });
 const registry = createFullOperationRegistry({ repository });
 expect(registry.get("entities.review.resolve")).toMatchObject({ requiredScope: "admin", trustBoundary: "local-only" });
 expect(await registry.execute(owner, "entities.review.resolve", input)).toMatchObject({ status: "rejected", replayed: false });
 expect(await resolveEntityReview(repository, owner, input)).toMatchObject({ status: "rejected", replayed: true });
 expect((await repository.snapshot()).pages.find((page) => page.id === target.id)?.revision).toBe(target.revision);
 await expect(registry.execute(owner, "put_page", { path: "notes/forged.md", content: "{}", expectedHead: await repository.head(), source: { type: "manas-entity", externalId: "forged" } })).rejects.toThrow("unknown field");
 const page = (await repository.snapshot()).pages.find((page) => page.id === target.id)!;
 await expect(registry.execute(owner, "put_page", { path: page.path, content: "{}", expectedRevision: page.revision, expectedHead: await repository.head() })).rejects.toMatchObject({ code: "graph_lifecycle_required" });
}), 15000);
test("review acceptance rejects changed or withdrawn evidence and stale candidates", async () => fixture(async ({ repository, memory, common }) => {
 const target = await putEntity(repository, owner, { ...common, name: "Alice", idempotencyKey: "alice" });
 if (target.needsReview) throw new Error("unexpected review");
 const proposed = await putEntity(repository, owner, { ...common, name: "Ally", aliases: ["Alice"], idempotencyKey: "proposal" });
 if (!proposed.needsReview) throw new Error("expected review");
 const input = { id: proposed.review.id, expectedRevision: proposed.review.revision, idempotencyKey: "merge", decision: "merge" as const, targetId: target.id };
 await putEntity(repository, owner, { ...common, id: target.id, expectedRevision: target.revision, name: "Alice", aliases: ["new alias"], idempotencyKey: "changed" });
 await expect(resolveEntityReview(repository, owner, input)).rejects.toMatchObject({ code: "stale_review" });
 await forget(repository, owner, { id: memory.id, expectedRevision: memory.revision, idempotencyKey: "withdraw" });
 await expect(resolveEntityReview(repository, owner, input)).rejects.toMatchObject({ code: "evidence_unavailable" });
 expect((await entityReviews(repository, owner)).reviews).toMatchObject([{ status: "stale" }]);
}), 15000);

test("owner can keep homonyms separate and reject obsolete proposals without reviving evidence", async () => fixture(async ({ repository, memory, common }) => {
 const target = await putEntity(repository, owner, { ...common, name: "Alice", idempotencyKey: "alice" });
 if (target.needsReview) throw new Error("unexpected review");
 const proposed = await putEntity(repository, owner, { ...common, name: "Other Alice", aliases: ["Alice"], idempotencyKey: "homonym" });
 if (!proposed.needsReview) throw new Error("expected review");
 const input = { id: proposed.review.id, expectedRevision: proposed.review.revision, idempotencyKey: "separate", decision: "separate" as const };
 await expect(resolveEntityReview(repository, owner, input, { faultInjector: async (point) => { if (point === "after-target") throw new Error("crash"); } })).rejects.toThrow("crash");
 expect(await resolveEntityReview(repository, owner, input)).toMatchObject({ status: "accepted" });
 expect((await resolveEntity(repository, owner, "Alice"))).toMatchObject({ needsReview: true });
 expect((await queryRelationships(repository, owner, { from: "Alice" })).outcome).toBe("ambiguous_entity");
 const obsolete = await putEntity(repository, owner, { ...common, name: "Third Alice", aliases: ["Alice"], idempotencyKey: "obsolete" });
 if (!obsolete.needsReview) throw new Error("expected review");
 await forget(repository, owner, { id: memory.id, expectedRevision: memory.revision, idempotencyKey: "withdraw" });
 expect(await resolveEntityReview(repository, owner, { id: obsolete.review.id, expectedRevision: obsolete.review.revision, idempotencyKey: "reject-obsolete", decision: "reject" })).toMatchObject({ status: "rejected" });
 expect((await resolveEntity(repository, owner, "Alice")).entities).toEqual([]);
}), 15000);

test("cancelled review intents stay resumable and review pagination retains every proposal", async () => fixture(async ({ repository, common }) => {
 const target = await putEntity(repository, owner, { ...common, name: "Alice", idempotencyKey: "alice" });
 if (target.needsReview) throw new Error("unexpected review");
 const proposals = [];
 for (const name of ["One", "Two"]) {
  const result = await putEntity(repository, owner, { ...common, name, aliases: ["Alice"], idempotencyKey: name });
  if (!result.needsReview) throw new Error("expected review");
  proposals.push(result.review);
 }
 const first = await entityReviews(repository, owner, { limit: 1 });
 const second = await entityReviews(repository, owner, { limit: 1, cursor: first.nextCursor });
 expect(first.nextCursor).toBeDefined();
 expect(new Set([...first.reviews, ...second.reviews].map((review) => review.id)).size).toBe(2);
 const proposal = proposals[0]!, abort = new AbortController();
 const input = { id: proposal.id, expectedRevision: proposal.revision, idempotencyKey: "cancelled", decision: "merge" as const, targetId: target.id };
 await expect(resolveEntityReview(repository, { ...owner, signal: abort.signal }, input, { faultInjector: async (point) => { if (point === "after-intent") abort.abort(); } })).rejects.toMatchObject({ code: "operation_cancelled" });
 expect((await repository.snapshot()).pages.find((page) => page.id === target.id)?.revision).toBe(target.revision);
 expect(await resolveEntityReview(repository, owner, input)).toMatchObject({ status: "accepted" });
}), 15000);
