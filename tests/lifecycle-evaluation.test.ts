import { test, expect } from "bun:test";
import { runLifecycleEvaluation, assertLifecycleEvaluation } from "../src/brain/lifecycle-evaluation";
import baseline from "../docs/retrieval-baseline-v2.json";
import before from "../docs/retrieval-baseline-v2-before-safety.json";

test("development and held-out fixtures execute deterministic production lifecycle and graph queries", async () => {
 const first = await runLifecycleEvaluation(), second = await runLifecycleEvaluation();
 expect(first).toEqual(second);
 expect(first.corpusHash).toBe(before.corpusHash);
 expect(() => assertLifecycleEvaluation(first, baseline)).not.toThrow();
 expect(first.suites.map((suite) => suite.cases)).toEqual([29, 29]);
 for (const suite of first.suites) {
  expect(suite.metrics).toEqual({ recallAt10: 1, mrr: 1, ndcgAt10: 1, relationshipExactMatch: 1 });
  expect(suite.safety).toEqual({ invalidCitations: 0, forbiddenResults: 0, staleProjectionSuppressed: true, replayStayedWithdrawn: true });
  expect(new Set(suite.results.map((result) => result.phase)).size).toBe(6);
 }
 const invalid = structuredClone(first);
 invalid.suites[0]!.safety.invalidCitations = 1;
 expect(() => assertLifecycleEvaluation(invalid, baseline)).toThrow("safety failure");
 const regression = structuredClone(first);
 regression.suites[1]!.metrics.mrr = 0.5;
 expect(() => assertLifecycleEvaluation(regression, baseline)).toThrow("retrieval regression");
 const changed = structuredClone(first);
 changed.corpusHash = "changed";
 expect(() => assertLifecycleEvaluation(changed, baseline)).toThrow("corpus changed");
}, 120000);
