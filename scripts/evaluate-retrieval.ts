import { runAdvancedEvaluation } from "../src/brain/advanced-evaluation";

const report = await runAdvancedEvaluation();
const baseline = await Bun.file(new URL("../docs/retrieval-baseline.json", import.meta.url)).json();
if (baseline.corpusHash !== report.corpusHash) throw new Error("evaluation corpus changed; review and record a new baseline before comparing ranking");
console.log(JSON.stringify(report, null, 2));
if (!report.isolated) throw new Error("retrieval disclosed unauthorized evidence");
for (const metric of ["recallAt10", "mrr", "ndcgAt10"] as const) {
	if (report.metrics[metric] < baseline.metrics[metric]) throw new Error(`retrieval regression: ${metric}`);
}

const { runLifecycleEvaluation, assertLifecycleEvaluation } = await import("../src/brain/lifecycle-evaluation");
const lifecycle = await runLifecycleEvaluation();
const lifecycleBaseline = await Bun.file(new URL("../docs/retrieval-baseline-v2.json", import.meta.url)).json();
assertLifecycleEvaluation(lifecycle, lifecycleBaseline);
console.log(JSON.stringify(lifecycle, null, 2));
