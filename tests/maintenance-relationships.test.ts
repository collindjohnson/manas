import { remember, forget } from "../src/brain/memory";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { BrainRepository } from "../src/brain/repository";
import { openPgliteBrainStore } from "../src/brain/store";
import { maintenanceScanHandler, maintenanceProposals } from "../src/brain/maintenance-scan";
import { applyRelationshipProposal } from "../src/brain/maintenance-approval";
import { putEntity, queryRelationships } from "../src/brain/entity-relationships";
import { enqueueJob, runOneJob } from "../src/brain/jobs";
import { validateRelationFindings } from "../src/brain/maintenance-assertions";
import { indexBrainRepository, searchVerifiedHybridBrainRepository } from "../src/brain/pglite-indexer";
const owner = { scope: "admin" as const };
function relation(text: string, subject: string, predicate: string, object: string, objectType = "place") {
 const span = (value: string) => ({ start: text.indexOf(value), end: text.indexOf(value) + value.length });
 return { span: { start: 0, end: text.length }, subject: { ...span(subject), type: "person" }, predicate: span(predicate), object: { ...span(object), type: objectType }, confidence: 0.95 };
}
async function fixture(managed = false) {
 const root = await mkdtemp(join(tmpdir(), "manas-maintenance-relationships-"));
 const repository = new BrainRepository(join(root, "brain")), store = await openPgliteBrainStore();
 await repository.initialize();
 execFileSync("git", ["-C", repository.root, "config", "user.name", "Test"]);
 execFileSync("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
 const brainId = (await repository.getIdentity()).brainId;
 let calls = 0, confidence = 0.95;
 const provider = { id: "local-relation-fixture", fingerprint: "fixture-v1", generate: async (prompt: string) => {
  calls++;
  const text = JSON.parse(prompt.slice(prompt.indexOf("Source: ") + 8)) as string;
  const object = text.includes("Denver") ? "Denver" : "Boston";
  return JSON.stringify({ spans: [], relationships: [{ ...relation(text, "Maya", "is based in", object), confidence }] });
 } };
 const handler = maintenanceScanHandler({ repository, store, workerId: "worker", provider, managedWrites: () => managed });
 const scan = async () => { await enqueueJob(store, { type: "maintenance-scan", payload: { brainId } }); return runOneJob(store, "worker", { "maintenance-scan": handler }); };
 return { repository, store, scan, setManaged: (value: boolean) => { managed = value; }, setModel: (fingerprint: string, value: number) => { provider.fingerprint = fingerprint; confidence = value; }, calls: () => calls, close: async () => { await store.close(); await rm(root, { recursive: true, force: true }); } };
}
test("relationship findings remain proposals until owner approval and retain source visibility", async () => {
 const f = await fixture();
 try {
  const source = await f.repository.putPage("notes/location.md", "Maya is based in Denver.", undefined, { type: "manas-memory-independent-fixture", externalId: "not-owner" });
  // A described source is excluded from owner-assertion extraction.
  await f.scan(); expect(f.calls()).toBe(0);
  await f.repository.putPage("notes/owner-location.md", "Maya is based in Denver.");
  const original = await f.repository.getPage("notes/owner-location.md");
  await f.repository.setPageAccessLabels(original!.path, ["private"], original!.revision);
  await f.scan();
  const items = (await maintenanceProposals(f.repository, owner)).items.filter((item) => item.kind === "relationship");
  expect(items).toHaveLength(1);
  const candidate = items[0]!;
  expect(candidate).toMatchObject({ kind: "relationship", status: "pending", details: { subject: "Maya", predicate: "is based in", object: "Denver" } });
  expect((await f.repository.snapshot()).pages.filter((page) => page.source?.type === "manas-relationship")).toHaveLength(0);
  const input = { id: candidate.id, expectedRevision: candidate.revision, idempotencyKey: "approve" };
  const accepted = await applyRelationshipProposal(f.repository, owner, input);
  const head = await f.repository.head();
  expect(await applyRelationshipProposal(f.repository, owner, input)).toMatchObject({ relationshipId: accepted.relationshipId, replayed: true });
  expect(await f.repository.head()).toBe(head);
  expect((await queryRelationships(f.repository, { scope: "read", allowedAccessLabels: [] }, { from: "Maya" })).results).toEqual([]);
  expect((await queryRelationships(f.repository, { scope: "read", allowedAccessLabels: ["private"] }, { from: "Maya", to: "Denver" })).results).toHaveLength(1);
  expect((await f.repository.snapshot()).pages.find((page) => page.id === accepted.relationshipId)?.accessLabels).toEqual(["private"]);
  expect(source.id).not.toBe(candidate.sources[0]!.id);
  await indexBrainRepository(f.store, f.repository);
  expect((await searchVerifiedHybridBrainRepository(f.store, f.repository, "Denver")).every((hit) => hit.citation.documentId !== candidate.id)).toBe(true);
 } finally { await f.close(); }
}, 20000);
test("approval resumes after a relationship commit without another edge or changed request", async () => {
 const f = await fixture();
 try {
  await f.repository.putPage("notes/location.md", "Maya is based in Denver.");
  await f.scan();
  const candidate = (await maintenanceProposals(f.repository, owner)).items[0]!;
  const input = { id: candidate.id, expectedRevision: candidate.revision, idempotencyKey: "crash-approval" };
  const put = f.repository.putPage.bind(f.repository);
  let fail = true;
  f.repository.putPage = async (...args) => {
   const result = await put(...args);
   if (fail && typeof args[3] === "object" && args[3].type === "manas-relationship") { fail = false; throw new Error("after edge commit"); }
   return result;
  };
  await expect(applyRelationshipProposal(f.repository, owner, input)).rejects.toThrow("after edge");
  await applyRelationshipProposal(f.repository, owner, input);
  const graph = (await f.repository.snapshot()).pages.filter((page) => ["manas-entity", "manas-relationship"].includes(page.source?.type ?? ""));
  expect(graph).toHaveLength(3);
  await expect(applyRelationshipProposal(f.repository, owner, { ...input, idempotencyKey: "different" })).rejects.toMatchObject({ code: "proposal_already_accepted" });
  await expect(applyRelationshipProposal(f.repository, { ...owner, allowedAccessLabels: [] }, input)).rejects.toMatchObject({ code: "owner_access_required" });
 } finally { await f.close(); }
}, 20000);
test("automatic managed writes leave conflicting functional assertions in review", async () => {
 const f = await fixture(true);
 try {
  await f.repository.putPage("notes/one.md", "Maya is based in Denver.");
  await f.repository.putPage("notes/two.md", "Maya is based in Boston.");
  await f.scan();
  const items = (await maintenanceProposals(f.repository, owner)).items;
  const relationships = items.filter((item) => item.kind === "relationship");
  expect(relationships.filter((item) => item.status === "accepted")).toHaveLength(1);
  expect(relationships.filter((item) => item.status === "pending")).toHaveLength(1);
  expect(items.filter((item) => item.kind === "contradiction")).toHaveLength(1);
  expect((await f.repository.snapshot()).pages.filter((page) => page.source?.type === "manas-relationship")).toHaveLength(1);
  const head = await f.repository.head();
  await f.scan();
  expect(await f.repository.head()).toBe(head);
  expect(f.calls()).toBe(2);
 } finally { await f.close(); }
}, 20000);
test("ambiguous entity types remain reviewable and source edits suppress relationship findings", async () => {
 const f = await fixture();
 try {
  const source = await f.repository.putPage("notes/location.md", "Maya is based in Denver.");
  await f.scan();
  const candidate = (await maintenanceProposals(f.repository, owner)).items[0]!;
  await putEntity(f.repository, owner, { name: "Maya", entityType: "organization", aliases: [], evidence: candidate.evidence!.map((item) => item.citation), confidence: 1, idempotencyKey: "other-maya" });
  const input = { id: candidate.id, expectedRevision: candidate.revision, idempotencyKey: "ambiguous-approval" };
  await expect(applyRelationshipProposal(f.repository, owner, input)).rejects.toMatchObject({ code: "ambiguous_entity" });
  expect((await maintenanceProposals(f.repository, owner)).items).toMatchObject([{ status: "pending" }]);
  await f.repository.putPage(source.path, "Maya moved elsewhere.", source.revision);
  await expect(applyRelationshipProposal(f.repository, owner, input)).rejects.toMatchObject({ code: "proposal_unavailable" });
  const result = await maintenanceProposals(f.repository, owner);
  expect(result.items).toMatchObject([{ freshness: "stale" }]);
  expect(JSON.stringify(result)).not.toContain("Denver");
 } finally { await f.close(); }
}, 20000);
test("relationship validation rejects invented spans, unsupported types, and uncited validity", () => {
 const text = "Maya is based in Denver.";
 const finding = relation(text, "Maya", "is based in", "Denver");
 expect(validateRelationFindings([finding], text)).toHaveLength(1);
 expect(() => validateRelationFindings([{ ...finding, object: { start: 100, end: 106, type: "place" } }], text)).toThrow("span");
 expect(() => validateRelationFindings([{ ...finding, subject: { ...finding.subject, type: "secret" } }], text)).toThrow("type");
 expect(() => validateRelationFindings([{ ...finding, validUntil: "2099-01-01" }], text)).toThrow("literally");
});

test("accepted maintenance relationships are withdrawn with their memory source after rebuild", async () => {
 const f = await fixture();
 try {
  const memory = await remember(f.repository, owner, { text: "Maya is based in Denver.", idempotencyKey: "memory", provenance: { sourceType: "owner" } });
  await f.scan();
  const candidate = (await maintenanceProposals(f.repository, owner)).items.find((item) => item.kind === "relationship")!;
  await applyRelationshipProposal(f.repository, owner, { id: candidate.id, expectedRevision: candidate.revision, idempotencyKey: "memory-approval" });
  expect((await queryRelationships(f.repository, owner, { from: "Maya" })).results).toHaveLength(1);
  await forget(f.repository, owner, { id: memory.id, expectedRevision: memory.revision, idempotencyKey: "withdraw" });
  await indexBrainRepository(f.store, f.repository);
  expect((await queryRelationships(f.repository, owner, { from: "Maya" })).results).toEqual([]);
  expect(JSON.stringify(await maintenanceProposals(f.repository, owner))).not.toContain("Denver");
  await f.scan();
  expect((await queryRelationships(f.repository, owner, { from: "Maya" })).results).toEqual([]);
 } finally { await f.close(); }
}, 20000);
test("external Google assertions retain source attribution without creating owner facts", async () => {
 const f = await fixture();
 try {
  const source = await f.repository.putPage("email/message.md", "Maya is based in Denver.", undefined, { type: "google:account:gmail:boundary", externalId: "message", provenance: { sourceType: "google:account:gmail:boundary", sourcePath: "google:gmail:message", retrievedAt: new Date().toISOString() } });
  await f.scan();
  const items = (await maintenanceProposals(f.repository, owner)).items;
  expect(items).toMatchObject([{ kind: "relationship", sources: [{ id: source.id }], evidence: [{ citation: { documentId: source.id } }] }]);
  expect((await f.repository.snapshot()).pages.filter((page) => page.source?.type === "manas-memory")).toEqual([]);
 } finally { await f.close(); }
}, 20000);
test("revoking managed writes stops between graph mutations and retries reuse the same analysis", async () => {
 const f = await fixture(true);
 try {
  await f.repository.putPage("notes/location.md", "Maya is based in Denver.");
  const put = f.repository.putPage.bind(f.repository);
  let revoked = false;
  f.repository.putPage = async (...args) => {
   const result = await put(...args);
   if (!revoked && typeof args[3] === "object" && args[3].type === "manas-entity") { revoked = true; f.setManaged(false); }
   return result;
  };
  await expect(f.scan()).rejects.toMatchObject({ code: "managed_writes_disabled" });
  expect((await f.repository.snapshot()).pages.filter((page) => page.source?.type === "manas-relationship")).toEqual([]);
  f.setManaged(true);
  await f.scan();
  expect((await f.repository.snapshot()).pages.filter((page) => ["manas-entity", "manas-relationship"].includes(page.source?.type ?? ""))).toHaveLength(3);
  expect(f.calls()).toBe(1);
 } finally { await f.close(); }
}, 20000);

test("model confidence changes do not duplicate or silently promote an existing review proposal", async () => {
 const f = await fixture(true);
 try {
  f.setModel("low-confidence", 0.4);
  await f.repository.putPage("notes/location.md", "Maya is based in Denver.");
  await f.scan();
  f.setModel("changed-model", 0.99);
  await f.scan();
  const items = (await maintenanceProposals(f.repository, owner)).items;
  expect(items).toMatchObject([{ kind: "relationship", status: "pending", details: { confidence: 0.4 } }]);
  expect(items).toHaveLength(1);
  expect((await f.repository.snapshot()).pages.filter((page) => page.source?.type === "manas-relationship")).toEqual([]);
  expect(f.calls()).toBe(2);
 } finally { await f.close(); }
}, 20000);
