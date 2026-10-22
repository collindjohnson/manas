import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { BrainRepository } from "./repository";
import { openPgliteBrainStore } from "./store";
import { indexBrainRepository, searchVerifiedHybridBrainRepository } from "./pglite-indexer";
const execFile = promisify(execFileCallback);
import { buildScorecard, replayEvaluation, type EvaluationCase } from "./advanced";

export interface AdvancedEvaluationFixture { id: string; query: string; expectedIds: string[]; allowedAccessLabels: string[]; tenantId?: string; }
export interface AdvancedEvaluationReport {
	corpus: string;
	corpusHash: string;
	cases: number;
	replay: ReturnType<typeof replayEvaluation>;
	scorecard: ReturnType<typeof buildScorecard>;
	metrics: { recallAt10: number; mrr: number; ndcgAt10: number };
	results: EvaluationCase[];
	isolated: boolean;
	warnings: string[];
}
export interface DiscoveredFeature { id: string; category: "routing" | "memory" | "code" | "evaluation" | "maintenance"; acceptance: string; }

export const ADVANCED_EVALUATION_DOCUMENTS = [
	{ id: "owner", text: "Project Juniper owner is Maya. Session recorded the ownership decision.", labels: [] },
	{ id: "decision", text: "Juniper launch decision date is September 14, 2026.", labels: [] },
	{ id: "code", text: "The reconcileCheckpoint caller is syncSource in the connector worker.", labels: [] },
	{ id: "private", text: "Confidential Juniper vault passphrase is heliotrope.", labels: ["private"] },
	{ id: "noise", text: "Session tool output: build passed, tests passed, waiting for user input.", labels: [] },
] as const;
export const ADVANCED_EVALUATION_CORPUS: readonly AdvancedEvaluationFixture[] = [
	{ id: "cross-session", query: "Juniper owner", expectedIds: ["owner"], allowedAccessLabels: [] },
	{ id: "temporal", query: "launch decision date", expectedIds: ["decision"], allowedAccessLabels: [] },
	{ id: "code", query: "reconcileCheckpoint caller", expectedIds: ["code"], allowedAccessLabels: [] },
	{ id: "authorized", query: "heliotrope", expectedIds: ["private"], allowedAccessLabels: ["private"] },
	{ id: "visibility-denied", query: "heliotrope", expectedIds: [], allowedAccessLabels: [] },
	{ id: "tenant-denied", query: "Juniper", expectedIds: [], allowedAccessLabels: ["private"], tenantId: "other" },
];

export const ADVANCED_FEATURE_INVENTORY: readonly DiscoveredFeature[] = [
	{ id: "multi-source-routing", category: "routing", acceptance: "tenant-scoped healthy source priority" },
	{ id: "multi-brain-routing", category: "routing", acceptance: "tenant-scoped allowed brain priority" },
	{ id: "recall-forget", category: "memory", acceptance: "forgotten records are never recalled" },
	{ id: "code-graph", category: "code", acceptance: "definitions, references, callers, and documentation edges" },
	{ id: "longmemeval-replay", category: "evaluation", acceptance: "deterministic expected-versus-actual replay" },
	{ id: "retrieval-diagnostics", category: "evaluation", acceptance: "unverified candidates are reported" },
	{ id: "self-maintenance", category: "maintenance", acceptance: "bounded proposals require approval" },
];

/** Executes the production verified lexical/hybrid path without calling any inference service. */
export async function runAdvancedEvaluation(): Promise<AdvancedEvaluationReport> {
	const root = await mkdtemp(join(tmpdir(), "manas-evaluation-"));
	let store: Awaited<ReturnType<typeof openPgliteBrainStore>> | undefined;
	try {
		const repository = new BrainRepository(join(root, "brain"));
		await repository.initialize();
		await execFile("git", ["-C", repository.root, "config", "user.name", "Manas Evaluation"]);
		await execFile("git", ["-C", repository.root, "config", "user.email", "evaluation@manas.invalid"]);
		for (const document of ADVANCED_EVALUATION_DOCUMENTS) {
			const page = await repository.putPage(`notes/${document.id}.md`, document.text);
			if (document.labels.length) await repository.setPageAccessLabels(page.path, [...document.labels], page.revision, page.commit);
		}
		store = await openPgliteBrainStore();
		await indexBrainRepository(store, repository);
		const { brainId } = await repository.snapshot();
		const results: EvaluationCase[] = [];
		for (const fixture of ADVANCED_EVALUATION_CORPUS) {
			const hits = await searchVerifiedHybridBrainRepository(store, repository, fixture.query, { brainId, tenantId: fixture.tenantId ?? "local", allowedAccessLabels: fixture.allowedAccessLabels, limit: 10, autocut: false });
			results.push({ id: fixture.id, expectedIds: [...fixture.expectedIds], actualIds: [...new Set(hits.map((hit) => hit.path.replace(/^notes\//, "").replace(/\.md$/, "")))] });
		}
		const replay = replayEvaluation(results);
		const positive = results.filter((result) => result.expectedIds.length);
		let recallAt10 = 0, mrr = 0, ndcgAt10 = 0;
		for (const result of positive) {
			const relevant = new Set(result.expectedIds);
			const actual = result.actualIds.slice(0, 10);
			recallAt10 += actual.filter((id) => relevant.has(id)).length / relevant.size;
			const first = actual.findIndex((id) => relevant.has(id));
			mrr += first < 0 ? 0 : 1 / (first + 1);
			const dcg = actual.reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
			const ideal = Array.from({ length: Math.min(10, relevant.size) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
			ndcgAt10 += dcg / ideal;
		}
		const metrics = { recallAt10: recallAt10 / positive.length, mrr: mrr / positive.length, ndcgAt10: ndcgAt10 / positive.length };
		const isolated = results.filter((result) => !result.expectedIds.length).every((result) => !result.actualIds.length);
		return { corpus: "manas-retrieval-v1", corpusHash: createHash("sha256").update(JSON.stringify({ documents: ADVANCED_EVALUATION_DOCUMENTS, queries: ADVANCED_EVALUATION_CORPUS })).digest("hex"), cases: results.length, replay, metrics, results, isolated, scorecard: buildScorecard("retrieval", Object.entries(metrics).map(([id, value]) => ({ id, value, weight: 1 }))), warnings: isolated ? [] : ["unauthorized retrieval detected"] };
	} finally {
		try { await store?.close(); } finally { await rm(root, { recursive: true, force: true }); }
	}
}

export function discoverAdvancedFeatures(): DiscoveredFeature[] { return ADVANCED_FEATURE_INVENTORY.map((feature) => ({ ...feature })); }

export function proposeSelfMaintenance(input: { tenantId: string; brainId: string; findings: string[]; dryRun?: boolean }): { tenantId: string; brainId: string; dryRun: boolean; proposals: Array<{ id: string; finding: string; requiresApproval: true }> } {
	if (!input.tenantId.trim() || !input.brainId.trim() || input.findings.some((finding) => !finding.trim())) throw new Error("invalid maintenance scope");
	return { tenantId: input.tenantId, brainId: input.brainId, dryRun: input.dryRun ?? true, proposals: [...new Set(input.findings)].slice(0, 32).map((finding, index) => ({ id: `maintenance-${index + 1}`, finding, requiresApproval: true as const })) };
}
