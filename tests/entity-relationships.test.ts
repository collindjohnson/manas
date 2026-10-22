import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrainRepository } from "../src/brain/repository";
import { openPgliteBrainStore } from "../src/brain/store";
import { indexBrainRepository, searchVerifiedHybridBrainRepository } from "../src/brain/pglite-indexer";
import { putEntity, putRelationship, queryRelationships, resolveEntity, entityReviews } from "../src/brain/entity-relationships";
import { remember, forget } from "../src/brain/memory";

test("typed relationship plans return cited three-hop chains and suppress withdrawn evidence after rebuild", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-entities-"));
 const repository = new BrainRepository(join(root, "brain")), store = await openPgliteBrainStore();
 try {
  await repository.initialize();
  const run = promisify(execFile);
  await run("git", ["-C", repository.root, "config", "user.name", "Test"]);
  await run("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  const memory = await remember(repository, { scope: "admin" }, { text: "Maya owns Juniper. Juniper belongs to Cedar. Cedar is based in Denver.", idempotencyKey: "facts", provenance: { sourceType: "user" } });
  await indexBrainRepository(store, repository);
  const evidence = (await searchVerifiedHybridBrainRepository(store, repository, "Juniper")).map((hit) => hit.citation);
  const context = { scope: "write" as const, principal: "client", allowedAccessLabels: [] };
  const common = { evidence, confidence: 0.9, version: 1 as const, aliases: [] };
  const entities = [];
  for (const [index, name] of ["Maya", "Juniper", "Cedar", "Denver"].entries()) {
   const input = { ...common, name, entityType: "entity", idempotencyKey: "entity-" + index };
   const result = await putEntity(repository, context, input);
   expect(result.needsReview).toBe(false);
   if (result.needsReview) throw new Error("unexpected ambiguity");
   expect(await putEntity(repository, context, input)).toMatchObject({ id: result.id, replayed: true });
   entities.push(result);
  }
  for (const [index, relationshipType] of ["owns", "belongs-to", "based-in"].entries()) {
   const input = { ...common, fromId: entities[index]!.id, toId: entities[index + 1]!.id, relationshipType, idempotencyKey: "relation-" + index };
   const result = await putRelationship(repository, context, input);
   expect(await putRelationship(repository, context, input)).toMatchObject({ id: result.id, replayed: true });
  }
  const two = await queryRelationships(repository, context, { from: "Maya", to: "Denver", maximumDepth: 2 });
  expect(two.results).toEqual([]);
  const three = await queryRelationships(repository, context, { from: "Maya", to: "Denver", maximumDepth: 3 });
  expect(three.results).toHaveLength(1);
  expect((await queryRelationships(repository, context, { from: "Denver", to: "Maya", direction: "inbound" })).results).toHaveLength(1);
  expect(three.results[0]!.chain.map((edge) => edge.relationshipType)).toEqual(["owns", "belongs-to", "based-in"]);
  expect(three.results[0]!.chain.every((edge) => edge.evidence[0]!.documentId === memory.id)).toBe(true);
  expect((await queryRelationships(repository, context, { from: "Maya", maximumResults: 1 })).results).toHaveLength(1);
  const proposal = await putEntity(repository, context, { ...common, name: "Other Maya", aliases: ["Maya"], entityType: "person", idempotencyKey: "ambiguous" });
  expect(proposal).toMatchObject({ needsReview: true });
  expect((await entityReviews(repository, { scope: "admin" })).reviews).toMatchObject([{ status: "pending", action: "entity-merge" }]);
  expect((await resolveEntity(repository, context, "Maya")).entities).toHaveLength(1);
  await indexBrainRepository(store, repository);
  expect((await searchVerifiedHybridBrainRepository(store, repository, "Juniper")).every((hit) => hit.citation.documentId === memory.id)).toBe(true);
  await forget(repository, { scope: "admin" }, { id: memory.id, expectedRevision: memory.revision, idempotencyKey: "withdraw" });
  expect((await queryRelationships(repository, context, { from: "Maya", to: "Denver" })).results).toEqual([]);
  await indexBrainRepository(store, repository);
  expect((await resolveEntity(repository, context, "Maya")).entities).toEqual([]);
  const staleReviews = await entityReviews(repository, { scope: "admin" });
  expect(staleReviews.reviews).toMatchObject([{ status: "stale" }]);
  expect(JSON.stringify(staleReviews)).not.toContain("Maya");
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}, 20000);

test("relationship traversal filters private intermediate entities and rejects forged or expired evidence", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-graph-grants-"));
 const repository = new BrainRepository(join(root, "brain")), store = await openPgliteBrainStore();
 try {
  await repository.initialize();
  const run = promisify(execFile);
  await run("git", ["-C", repository.root, "config", "user.name", "Test"]);
  await run("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  await repository.putPage("notes/facts.md", "Alpha is linked to Beta, which is linked to Gamma.");
  await indexBrainRepository(store, repository);
  const evidence = (await searchVerifiedHybridBrainRepository(store, repository, "Alpha")).map((hit) => hit.citation);
  const owner = { scope: "admin" as const };
  const base = { evidence, confidence: 1, version: 1 as const, aliases: [], entityType: "entity" };
  const ids: string[] = [];
  for (const name of ["Alpha", "Beta", "Gamma"]) {
   const result = await putEntity(repository, owner, { ...base, name, idempotencyKey: name, visibility: name === "Beta" ? ["private"] : [] });
   if (result.needsReview) throw new Error("unexpected review");
   ids.push(result.id);
  }
  await putRelationship(repository, owner, { ...base, fromId: ids[0]!, toId: ids[1]!, relationshipType: "linked", idempotencyKey: "one" });
  await putRelationship(repository, owner, { ...base, fromId: ids[1]!, toId: ids[2]!, relationshipType: "linked", idempotencyKey: "two" });
  expect((await queryRelationships(repository, { scope: "read", allowedAccessLabels: [] }, { from: "Alpha", to: "Gamma" })).results).toEqual([]);
  expect((await queryRelationships(repository, { scope: "read", allowedAccessLabels: ["private"] }, { from: "Alpha", to: "Gamma" })).results).toHaveLength(1);
  await expect(putEntity(repository, owner, { ...base, name: "Forged", idempotencyKey: "forged", evidence: [{ ...evidence[0]!, contentHash: "fake" }] })).rejects.toThrow("Evidence");
  await expect(putRelationship(repository, owner, { ...base, fromId: ids[0]!, toId: ids[1]!, relationshipType: "linked", idempotencyKey: "declassified", visibility: [] })).rejects.toThrow("Evidence");
  const expired = await putEntity(repository, owner, { ...base, name: "Expired", idempotencyKey: "expired", validUntil: "2000-01-01T00:00:00Z" });
  expect(expired.needsReview).toBe(false);
  expect((await resolveEntity(repository, owner, "Expired")).entities).toEqual([]);
  await expect(queryRelationships(repository, owner, { from: "Alpha", maximumDepth: 4 })).rejects.toThrow("bounded");
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);
