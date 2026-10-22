import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { BrainRepository } from "../src/brain/repository";
import { openPgliteBrainStore } from "../src/brain/store";
import { indexBrainRepository, searchVerifiedHybridBrainRepository } from "../src/brain/pglite-indexer";
import { remember, forget } from "../src/brain/memory";
import { createAnswer, getAnswer, definePin, pinStatus, enqueuePinRefresh, pinnedAnswerHandler, answerFeedback, resetAnswerFeedback } from "../src/brain/maintained-answers";
import { runOneJob } from "../src/brain/jobs";

test("pinned answers survive rebuilds, invalidate changed evidence, and bind feedback to exact revisions", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-pinned-"));
 const repository = new BrainRepository(join(root, "brain"));
 const store = await openPgliteBrainStore(join(root, "state"));
 try {
  await repository.initialize();
  const run = promisify(execFile);
  await run("git", ["-C", repository.root, "config", "user.name", "Test"]);
  await run("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  const memory = await remember(repository, { scope: "admin" }, { text: "Juniper owner is Maya.", visibility: ["personal"], provenance: { sourceType: "user" }, idempotencyKey: "memory" });
  await indexBrainRepository(store, repository);
  let calls = 0;
  const deps = { store, repository, provider: { generate: async (prompt: string) => {
   calls++;
   const payload = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
   return JSON.stringify({ answer: "Juniper owner is Maya.", citations: [payload.evidence[0].chunkId], knowledgeGaps: [] });
  } } };
  const owner = { scope: "admin" as const, principal: "owner" };
  const personal = { scope: "write" as const, principal: "client", allowedAccessLabels: ["personal"] };
  const pinInput = { question: "Juniper owner", visibility: ["personal"], idempotencyKey: "pin" };
  const pin = await definePin(deps, personal, pinInput);
  expect(await definePin(deps, personal, pinInput)).toMatchObject({ id: pin.id, replayed: true });
  await expect(definePin(deps, personal, { ...pinInput, question: "Other" })).rejects.toThrow("conflict");
  expect((await pinStatus(deps, personal, pin.id)).answer).toMatchObject({ freshness: "missing" });
  await expect(pinStatus(deps, { scope: "read", allowedAccessLabels: [] }, pin.id)).rejects.toThrow("unavailable");
  await indexBrainRepository(store, repository);
  expect((await searchVerifiedHybridBrainRepository(store, repository, "Juniper", { allowedAccessLabels: ["personal"] })).map((hit) => hit.citation.documentId)).not.toContain(pin.id);
  await enqueuePinRefresh(deps, personal, pin.id);
  const handler = pinnedAnswerHandler({ ...deps, workerId: "worker" });
  await runOneJob(store, "worker", { "pinned-answer-refresh": async (job) => { await handler(job); } });
  const current = await pinStatus(deps, personal, pin.id);
  expect(current.answer).toMatchObject({ freshness: "current", outcome: "answered", answer: "Juniper owner is Maya." });
  const answerId = (current.answer as { answerId: string }).answerId;
  const rating = { answerId, idempotencyKey: "rating", rating: 1 };
  const feedback = await answerFeedback(deps, personal, rating);
  expect(await answerFeedback(deps, personal, rating)).toEqual(feedback);
  expect(feedback.rankingInfluence).toBe(false);
  expect(await answerFeedback(deps, personal, { ...rating, idempotencyKey: "duplicate-rating" })).toEqual(feedback);
  const rows = await store.query<{ evidence: unknown }>("SELECT evidence FROM brain_answer_feedback");
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows[0].evidence)).toContain((await repository.snapshot()).pages.find((page) => page.id === memory.id)!.revision);
  await expect(answerFeedback(deps, personal, { ...rating, rating: -1 })).rejects.toThrow("conflict");
  await resetAnswerFeedback(deps, personal, answerId);
  expect(await store.query("SELECT id FROM brain_answer_feedback")).toEqual([]);
  await indexBrainRepository(store, repository);
  expect(await getAnswer(deps, personal, answerId)).toMatchObject({ freshness: "current" });
  await forget(repository, owner, { id: memory.id, expectedRevision: memory.revision, idempotencyKey: "withdraw" });
  const stale = await getAnswer(deps, personal, answerId);
  expect(stale).toMatchObject({ freshness: "stale" });
  expect(stale).not.toHaveProperty("answer");
  await indexBrainRepository(store, repository);
  expect(await getAnswer(deps, personal, answerId)).toMatchObject({ freshness: "stale" });
  await expect(answerFeedback(deps, personal, rating)).rejects.toThrow("unavailable");
  expect(calls).toBe(1);
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);

test("ad hoc answer receipts are principal-bound and never return stale private evidence", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-answer-receipt-"));
 const repository = new BrainRepository(join(root, "brain"));
 const store = await openPgliteBrainStore();
 try {
  await repository.initialize();
  const run = promisify(execFile);
  await run("git", ["-C", repository.root, "config", "user.name", "Test"]);
  await run("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  const memory = await remember(repository, { scope: "admin" }, { text: "Maple owner is Sam.", visibility: ["private"], provenance: { sourceType: "user" }, idempotencyKey: "memory" });
  await indexBrainRepository(store, repository);
  const context = { scope: "read" as const, principal: "first", allowedAccessLabels: ["private"] };
  const deps = { store, repository, provider: { generate: async (prompt: string) => {
   const payload = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
   return JSON.stringify({ answer: "Sam", citations: [payload.evidence[0].chunkId], knowledgeGaps: [] });
  } } };
  const answer = await createAnswer(deps, context, "Maple");
  expect(answer.outcome).toBe("answered");
  await expect(getAnswer(deps, { ...context, principal: "second" }, answer.answerId)).rejects.toThrow("unavailable");
  expect(await getAnswer(deps, { ...context, allowedAccessLabels: [] }, answer.answerId)).toMatchObject({ freshness: "stale" });
  await repository.putPage("notes/new.md", "unrelated change");
  await indexBrainRepository(store, repository);
  expect(await getAnswer(deps, context, answer.answerId)).toMatchObject({ freshness: "current" });
  await store.query("UPDATE brain_answer_receipts SET receipt=jsonb_set(receipt,'{createdAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE id=$1", [answer.answerId]);
  expect(await getAnswer(deps, context, answer.answerId)).toMatchObject({ freshness: "stale" });
  expect(memory.id).toBeString();
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}, 10000);

test("pinned refresh cancellation prevents publication and changed questions withdraw cached answers", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-pin-cancel-"));
 const repository = new BrainRepository(join(root, "brain"));
 const store = await openPgliteBrainStore();
 try {
  await repository.initialize();
  const run = promisify(execFile);
  await run("git", ["-C", repository.root, "config", "user.name", "Test"]);
  await run("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  await repository.putPage("notes/source.md", "Cedar owner is Alex.");
  await indexBrainRepository(store, repository);
  const context = { scope: "write" as const, principal: "owner", allowedAccessLabels: [] };
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((done) => { release = done; });
  const observed = new Promise<void>((done) => { started = done; });
  const deps = { store, repository, provider: { generate: async (prompt: string) => {
   started(); await waiting;
   const input = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
   return JSON.stringify({ answer: "Alex", citations: [input.evidence[0].chunkId], knowledgeGaps: [] });
  } } };
  const pin = await definePin(deps, context, { question: "Cedar owner", idempotencyKey: "question" });
  await indexBrainRepository(store, repository);
  const queued = await enqueuePinRefresh(deps, context, pin.id);
  const handler = pinnedAnswerHandler({ ...deps, workerId: "worker" });
  const running = runOneJob(store, "worker", { "pinned-answer-refresh": async (job) => { await handler(job); } });
  await observed;
  const { cancelJob } = await import("../src/brain/jobs");
  await cancelJob(store, queued.jobId);
  release();
  await running;
  expect(await store.query("SELECT id FROM brain_answer_receipts")).toEqual([]);
  const answer = await createAnswer(deps, context, "Cedar owner", pin);
  const changed = await definePin(deps, context, { id: pin.id, expectedRevision: pin.revision, question: "Cedar status", idempotencyKey: "changed" });
  expect(changed.revision).not.toBe(pin.revision);
  const stale = await getAnswer(deps, context, answer.answerId);
  expect(stale).toMatchObject({ freshness: "stale", reason: "question_changed" });
  expect(stale).not.toHaveProperty("answer");
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}, 10000);

test("full questions recover verified keyword evidence without widening client visibility", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-answer-question-"));
 const repository = new BrainRepository(join(root, "brain"));
 const store = await openPgliteBrainStore();
 try {
  await repository.initialize();
  await remember(repository, { scope: "admin" }, { text: "Juniper project owner is Maya.", visibility: [], provenance: { sourceType: "user" }, idempotencyKey: "public" });
  await remember(repository, { scope: "admin" }, { text: "Juniper project owner secret is Nora.", visibility: ["private"], provenance: { sourceType: "user" }, idempotencyKey: "private" });
  await indexBrainRepository(store, repository);
  let calls = 0;
  const provider = { generate: async (prompt: string) => {
   calls++;
   const data = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
   expect(JSON.stringify(data.evidence)).not.toContain("Nora");
   expect(data.evidence.some((item: { text: string }) => item.text.includes("Maya"))).toBe(true);
   return JSON.stringify({ answer: "Maya", citations: [data.evidence[0].chunkId], knowledgeGaps: [] });
  } };
  const answer = await createAnswer({ repository, store, provider }, { scope: "read", allowedAccessLabels: [] }, "Who is the Juniper project owner?");
  expect(answer.outcome).toBe("answered");
  expect(answer.answer).toBe("Maya");
  expect(calls).toBe(1);
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);
