import { buildScorecard, replayEvaluation, type EvaluationCase } from "./advanced";

export interface AdvancedEvaluationFixture extends EvaluationCase { tenantId: string; brainId: string; query: string; citations: string[]; }
export interface AdvancedEvaluationReport { corpus: string; cases: number; replay: ReturnType<typeof replayEvaluation>; scorecard: ReturnType<typeof buildScorecard>; isolated: boolean; warnings: string[]; }
export interface DiscoveredFeature { id: string; category: "routing" | "memory" | "code" | "evaluation" | "maintenance"; acceptance: string; }

export const ADVANCED_EVALUATION_CORPUS: readonly AdvancedEvaluationFixture[] = [
	{ id: "longmem-1", tenantId: "tenant-a", brainId: "brain-a", query: "project owner", expectedIds: ["doc-owner"], actualIds: ["doc-owner"], citations: ["doc-owner:chunk-1"] },
	{ id: "longmem-2", tenantId: "tenant-a", brainId: "brain-a", query: "decision date", expectedIds: ["doc-decision"], actualIds: ["doc-decision", "doc-stale"], citations: ["doc-decision:chunk-1"] },
	{ id: "code-1", tenantId: "tenant-a", brainId: "brain-a", query: "caller", expectedIds: ["code-definition"], actualIds: ["code-definition"], citations: ["code-definition:chunk-1"] },
	{ id: "isolation-1", tenantId: "tenant-b", brainId: "brain-b", query: "private", expectedIds: ["doc-private"], actualIds: ["doc-private"], citations: ["doc-private:chunk-1"] },
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

export function runAdvancedEvaluation(fixtures: readonly AdvancedEvaluationFixture[] = ADVANCED_EVALUATION_CORPUS): AdvancedEvaluationReport {
	if (!fixtures.length || fixtures.some((fixture) => !fixture.tenantId.trim() || !fixture.brainId.trim() || !fixture.query.trim() || fixture.citations.some((citation) => !citation.trim()))) throw new Error("advanced evaluation corpus is invalid");
	const replay = replayEvaluation(fixtures.map(({ id, expectedIds, actualIds }) => ({ id, expectedIds, actualIds })));
	const scorecard = buildScorecard("advanced-analysis", [{ id: "recall", value: replay.recall, weight: 2 }, { id: "precision", value: replay.precision, weight: 2 }, { id: "exact", value: replay.exactMatches / fixtures.length, weight: 1 }]);
	const scopes = new Set(fixtures.map((fixture) => `${fixture.tenantId}:${fixture.brainId}`));
	return { corpus: "gbrain-v0.42.65.0-synthetic", cases: fixtures.length, replay, scorecard, isolated: scopes.size >= 2, warnings: replay.recall < 1 ? ["corpus contains a deliberate stale-result case"] : [] };
}

export function discoverAdvancedFeatures(): DiscoveredFeature[] { return ADVANCED_FEATURE_INVENTORY.map((feature) => ({ ...feature })); }

export function proposeSelfMaintenance(input: { tenantId: string; brainId: string; findings: string[]; dryRun?: boolean }): { tenantId: string; brainId: string; dryRun: boolean; proposals: Array<{ id: string; finding: string; requiresApproval: true }> } {
	if (!input.tenantId.trim() || !input.brainId.trim() || input.findings.some((finding) => !finding.trim())) throw new Error("invalid maintenance scope");
	return { tenantId: input.tenantId, brainId: input.brainId, dryRun: input.dryRun ?? true, proposals: [...new Set(input.findings)].slice(0, 32).map((finding, index) => ({ id: `maintenance-${index + 1}`, finding, requiresApproval: true as const })) };
}
