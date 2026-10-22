import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BrainRepository } from "../src/brain/repository";
import { openPgliteBrainStore } from "../src/brain/store";
import { remember, correct, forget } from "../src/brain/memory";
import { indexBrainRepository } from "../src/brain/pglite-indexer";
import { createAnswer } from "../src/brain/maintained-answers";
import { OpenAiCompatibleGenerationProvider } from "../src/brain/providers";

// Explicit opt-in benchmark. Never reads owner configuration or real archives.
const model = process.argv[2];
if (!model) throw new Error("Usage: bun run scripts/evaluate-local-generation.ts LOCAL_MODEL");
const root = await mkdtemp(join(tmpdir(), "manas-local-generation-"));
const repository = new BrainRepository(join(root, "brain"));
const store = await openPgliteBrainStore(join(root, "state"));
const context = { scope: "admin" as const, principal: "evaluation" };
const fixtures = [
 { text: "Juniper project owner is Maya. Juniper launch date is 2027-04-18.", question: "Who is the Juniper project owner?", expected: "Maya", forbidden: ["Nora"] },
 { text: "Cobalt uses SQLite for its durable queue.", question: "Which database does Cobalt use for its durable queue?", expected: "SQLite", forbidden: ["Redis"] },
];
const cases: Array<Record<string, unknown>> = [];
try {
 await repository.initialize();
 const provider = new OpenAiCompatibleGenerationProvider(model, "http://127.0.0.1:11434/v1/chat/completions", undefined, "local", {}, { timeoutMs: 120000 });
 for (const [index, fixture] of fixtures.entries()) await remember(repository, context, { text: fixture.text, provenance: { sourceType: "evaluation" }, idempotencyKey: "fixture-" + index });
 const old = await remember(repository, context, { text: "Orchid release owner is Nora.", provenance: { sourceType: "evaluation" }, idempotencyKey: "orchid-old" });
 await correct(repository, context, { id: old.id, expectedRevision: old.revision, text: "Orchid release owner is Sam.", provenance: { sourceType: "evaluation" }, idempotencyKey: "orchid-correct" });
 const withdrawn = await remember(repository, context, { text: "Quartz launch location is Paris.", provenance: { sourceType: "evaluation" }, idempotencyKey: "quartz" });
 await forget(repository, context, { id: withdrawn.id, expectedRevision: withdrawn.revision, idempotencyKey: "quartz-withdraw" });
 await indexBrainRepository(store, repository);
 const queries = [...fixtures, { question: "Who is the Orchid release owner?", expected: "Sam", forbidden: ["Nora"] }, { question: "Where is the Quartz launch location?", expected: "", forbidden: ["Paris"] }];
 for (const fixture of queries) {
  const start = performance.now();
  const answer = await createAnswer({ store, repository, provider }, context, fixture.question);
  const text = answer.answer ?? "";
  const passed = fixture.expected ? answer.outcome === "answered" && text.toLowerCase().includes(fixture.expected.toLowerCase()) && answer.citations.length > 0 && fixture.forbidden.every((word) => !text.includes(word)) : answer.outcome === "insufficient_evidence" && !text;
  const result = { question: fixture.question, outcome: answer.outcome, answer: text, citations: answer.citations.length, latencyMs: Math.round(performance.now() - start), passed };
  cases.push(result);
  console.error(JSON.stringify(result));
 }
 const report = { version: 1, createdAt: new Date().toISOString(), model, providerFingerprint: provider.fingerprint, endpoint: "http://127.0.0.1:11434", seedFixtureHash: createHash("sha256").update(JSON.stringify(fixtures)).digest("hex"), isolated: true, cases, passed: cases.every((item) => item.passed), limitations: "Four synthetic cases; phrase checks and production citation verification, not a general semantic grounding or quality estimate. First request includes model load. Latency includes retrieval and receipt persistence." };
 console.log(JSON.stringify(report, null, 2));
 if (!report.passed) process.exitCode = 1;
} finally { await store.close(); await rm(root, { recursive: true, force: true }); }
