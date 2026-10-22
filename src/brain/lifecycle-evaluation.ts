import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrainRepository } from "./repository";
import { openPgliteBrainStore } from "./store";
import { createFullOperationRegistry } from "./operation-catalog";
import { indexBrainRepository, searchVerifiedHybridBrainRepository, type Citation } from "./pglite-indexer";
import { correct, forget, remember, type MemoryReceipt } from "./memory";
import { verifyEvidence } from "./evidence-contract";
import { putEntity, putRelationship, queryRelationships } from "./entity-relationships";
import { EVALUATION_V2_FIXTURES, EVALUATION_V2_POLICY, evaluationV2Documents, evaluationV2Memories, evaluationV2Cases, type EvaluationV2Fixture, type EvaluationV2Case } from "./evaluation-fixtures";
const run = promisify(execFile);
const owner = { scope: "admin" as const, tenantId: "local", principal: "evaluation-owner" };
export interface LifecycleEvaluationResult {
 id: string; phase: string; surface: EvaluationV2Case["surface"]; expectedIds: string[]; actualIds: string[]; invalidCitations: number; forbiddenResults: number;
}
export function lifecycleMetrics(results: LifecycleEvaluationResult[]) {
 const positive = results.filter((result) => result.surface !== "relationships" && result.expectedIds.length);
 let recallAt10 = 0, mrr = 0, ndcgAt10 = 0;
 for (const result of positive) {
  const relevant = new Set(result.expectedIds), actual = result.actualIds.slice(0, 10);
  recallAt10 += actual.filter((id) => relevant.has(id)).length / relevant.size;
  const first = actual.findIndex((id) => relevant.has(id));
  mrr += first < 0 ? 0 : 1 / (first + 1);
  const dcg = actual.reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(10, relevant.size) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  ndcgAt10 += dcg / ideal;
 }
 const graphs = results.filter((result) => result.surface === "relationships");
 return { recallAt10: recallAt10 / positive.length, mrr: mrr / positive.length, ndcgAt10: ndcgAt10 / positive.length, relationshipExactMatch: graphs.filter((result) => JSON.stringify(result.actualIds) === JSON.stringify(result.expectedIds)).length / graphs.length };
}
async function runSuite(fixture: EvaluationV2Fixture) {
 const root = await mkdtemp(join(tmpdir(), "manas-lifecycle-evaluation-"));
 const repository = new BrainRepository(join(root, "brain"));
 const store = await openPgliteBrainStore();
 try {
  await repository.initialize();
  await run("git", ["-C", repository.root, "config", "user.name", "Manas Evaluation"]);
  await run("git", ["-C", repository.root, "config", "user.email", "evaluation@manas.invalid"]);
  const ids = new Map<string, string>(), memories = new Map<string, MemoryReceipt>();
  for (const document of evaluationV2Documents(fixture)) {
   const source = { type: document.id === "generated" ? "manas-generated-answer" : "evaluation", externalId: document.id, provenance: { sourceType: "evaluation", retrievedAt: document.updatedAt, metadata: { updated_at: document.updatedAt } } };
   const page = await repository.putPage("notes/" + document.id + ".md", document.text, undefined, source);
   ids.set(page.id, document.id);
   if (document.labels.length) await repository.setPageAccessLabels(page.path, document.labels, page.revision, page.commit);
  }
  await repository.markStaleBySource("evaluation", "stale");
  for (const memory of evaluationV2Memories(fixture)) {
   const receipt = await remember(repository, owner, { ...memory, idempotencyKey: memory.id, provenance: { sourceType: "user" } });
   memories.set(memory.id, receipt); ids.set(receipt.id, memory.id);
  }
  await indexBrainRepository(store, repository);
  const graphMemory = memories.get("memory-graph")!;
  const evidence = (await searchVerifiedHybridBrainRepository(store, repository, fixture.graph[0])).filter((hit) => hit.citation.documentId === graphMemory.id).map((hit) => hit.citation);
  if (!evidence.length) throw new Error("graph fixture evidence missing");
  const entities: string[] = [];
  for (const [index, name] of fixture.graph.entries()) {
   const entity = await putEntity(repository, owner, { name, entityType: "entity", aliases: index === 0 ? [fixture.alias] : [], visibility: index === EVALUATION_V2_POLICY.graphPrivateIndex ? ["private"] : [], evidence, confidence: 1, idempotencyKey: "entity-" + index });
   if (entity.needsReview) throw new Error("ambiguous fixture entity");
   entities.push(entity.id);
  }
  for (const [index, relationshipType] of EVALUATION_V2_POLICY.graphPredicates.entries()) await putRelationship(repository, owner, { fromId: entities[index]!, toId: entities[index + 1]!, relationshipType, evidence, confidence: 1, idempotencyKey: "edge-" + index });
  const registry = createFullOperationRegistry({ repository, store });
  const results: LifecycleEvaluationResult[] = [];
  let staleProjectionSuppressed = true, replayStayedWithdrawn = false;
  for (const phase of EVALUATION_V2_POLICY.phases) {
   if (phase === "corrected") {
    const receipt = memories.get("memory-owner")!;
    memories.set("memory-owner", await correct(repository, owner, { id: receipt.id, expectedRevision: receipt.revision, idempotencyKey: "correction", text: fixture.project + " owner is " + fixture.currentOwner + ". " + fixture.newWord, provenance: { sourceType: "user" } }));
   }
   if (phase === "withdrawn") {
    for (const name of ["memory-withdrawn", "memory-graph"]) {
     const receipt = memories.get(name)!;
     await forget(repository, owner, { id: receipt.id, expectedRevision: receipt.revision, idempotencyKey: "withdraw-" + name });
    }
    staleProjectionSuppressed = (await searchVerifiedHybridBrainRepository(store, repository, fixture.withdrawnWord)).length === 0;
   }
   if (phase === "permission-changed") {
    const snapshot = await repository.snapshot(), page = snapshot.pages.find((page) => ids.get(page.id) === "session-decision")!;
    await repository.setPageAccessLabels(page.path, ["private"], page.revision, snapshot.commit);
   }
   if (phase === "rebuilt") await indexBrainRepository(store, repository);
   if (phase === "replayed") {
    const memory = evaluationV2Memories(fixture).find((memory) => memory.id === "memory-withdrawn")!;
    const replay = await remember(new BrainRepository(repository.root), owner, { ...memory, idempotencyKey: memory.id, provenance: { sourceType: "user" } });
    replayStayedWithdrawn = replay.replayed && replay.currentStatus === "withdrawn";
   }
   for (const testCase of evaluationV2Cases(fixture).filter((testCase) => testCase.phase === phase)) {
    const context = { scope: "read" as const, tenantId: testCase.deniedTenant ? "other" : "local", allowedAccessLabels: testCase.labels ?? [] };
    const citations: Citation[] = [];
    let actualIds: string[] = [];
    try {
     if (testCase.surface === "relationships") {
      const response = await queryRelationships(repository, context, testCase.graph as Parameters<typeof queryRelationships>[2]);
      actualIds = response.results.map((result) => result.chain.map((edge) => edge.relationshipType).join(">"));
      for (const result of response.results) { citations.push(...result.entity.evidence); for (const edge of result.chain) citations.push(...edge.evidence); }
     } else {
      const response = await registry.execute(context, testCase.surface === "search" ? "retrieval.search" : "memory.recall", { query: testCase.query, limit: 10, ...(testCase.surface === "search" ? { options: { mode: "keyword", ...testCase.options } } : {}) }) as { results: { id: string; citation: Citation }[] };
      citations.push(...response.results.map((hit) => hit.citation));
      actualIds = [...new Set(response.results.map((hit) => {
       const logical = ids.get(hit.citation.documentId);
       if (!logical) throw new Error("unknown fixture document returned");
       return logical;
      }))];
     }
     if (testCase.deniedTenant) throw new Error("tenant denial was not enforced");
    } catch (error) {
     if (!testCase.deniedTenant || !(error instanceof Error) || error.message !== "brain scope is not authorized") throw error;
    }
    let invalidCitations = 0;
    const snapshot = await repository.snapshot();
    for (const citation of citations) {
     try { await verifyEvidence(repository, snapshot, context, citation); } catch { invalidCitations++; }
    }
    results.push({ id: testCase.id, phase, surface: testCase.surface, expectedIds: testCase.expectedIds, actualIds, invalidCitations, forbiddenResults: testCase.expectedIds.length ? 0 : actualIds.length });
   }
  }
  return { split: fixture.split, cases: results.length, metrics: lifecycleMetrics(results), safety: { invalidCitations: results.reduce((sum, result) => sum + result.invalidCitations, 0), forbiddenResults: results.reduce((sum, result) => sum + result.forbiddenResults, 0), staleProjectionSuppressed, replayStayedWithdrawn }, results };
 } finally { try { await store.close(); } finally { await rm(root, { recursive: true, force: true }); } }
}
/** Fixed production-path queries; no provider, account, or user archive is consulted. */
export async function runLifecycleEvaluation() {
 const corpus = EVALUATION_V2_FIXTURES.map((fixture) => ({ fixture, documents: evaluationV2Documents(fixture), memories: evaluationV2Memories(fixture), queries: evaluationV2Cases(fixture) }));
 const suites = [];
 for (const fixture of EVALUATION_V2_FIXTURES) suites.push(await runSuite(fixture));
 return { corpus: "manas-retrieval-v2", corpusHash: createHash("sha256").update(JSON.stringify({ policy: EVALUATION_V2_POLICY, corpus })).digest("hex"), inference: "disabled", suites };
}

export function assertLifecycleEvaluation(report: Awaited<ReturnType<typeof runLifecycleEvaluation>>, baseline: { corpus: string; corpusHash: string; suites: Array<{ split: string; cases: number; metrics: ReturnType<typeof lifecycleMetrics> }> }) {
 if (report.corpusHash !== baseline.corpusHash || report.corpus !== baseline.corpus) throw new Error("lifecycle evaluation corpus changed; review and record a new baseline");
 if (report.inference !== "disabled" || report.suites.length !== EVALUATION_V2_FIXTURES.length) throw new Error("invalid lifecycle evaluation configuration");
 for (const suite of report.suites) {
  const expected = baseline.suites.find((candidate) => candidate.split === suite.split);
  if (!expected || suite.cases !== expected.cases || suite.results.length !== suite.cases) throw new Error("lifecycle evaluation cases changed");
  if (suite.safety.invalidCitations || suite.safety.forbiddenResults || !suite.safety.staleProjectionSuppressed || !suite.safety.replayStayedWithdrawn) throw new Error("lifecycle evaluation safety failure: " + suite.split);
  for (const metric of ["recallAt10", "mrr", "ndcgAt10", "relationshipExactMatch"] as const) {
   if (!Number.isFinite(suite.metrics[metric]) || suite.metrics[metric] < expected.metrics[metric]) throw new Error("lifecycle retrieval regression: " + suite.split + ":" + metric);
  }
 }
}
