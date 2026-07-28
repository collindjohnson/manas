import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "advanced"].join(String.fromCharCode(47));
const { analyzeCodeDocument, brainstormIdeas, buildScorecard, buildTrajectory, calibrateConfidence, captureContributorQuery, diagnoseRetrieval, forgetMemory, linkDocumentation, recallMemories, replayEvaluation, routeMultiBrainQuery, routeMultiSourceQuery } = await import(modulePath);
const evaluationModule = await import("../src/brain/advanced-evaluation");

describe("advanced local analysis", () => {
	test("extracts code symbols, references, and documentation edges", () => {
		const code = analyzeCodeDocument("src/example.ts", "function build() { return build(); }\nconst value = 1;");
		expect(code.symbols.map((symbol: { name: string }) => symbol.name)).toEqual(["build", "value"]);
		expect(code.edges.some((edge: { type: string }) => edge.type === "calls")).toBe(true);
		expect(linkDocumentation("docs/example.md", "The build function.", code)).toMatchObject([{ type: "documents" }]);
	});

	test("orders bounded trajectories and reports replay metrics", () => {
		const trajectory = buildTrajectory("run", [{ id: "b", at: "2026-01-02T00:00:00Z", label: "second" }, { id: "a", at: "2026-01-01T00:00:00Z", label: "first" }]);
		expect(trajectory.events.map((event: { id: string }) => event.id)).toEqual(["a", "b"]);
		expect(replayEvaluation([{ id: "one", expectedIds: ["a", "b"], actualIds: ["a", "c"] }])).toMatchObject({ cases: 1, exactMatches: 0, recall: 0.5, precision: 0.5 });
	});

	test("routes, scores, calibrates, and bounds advanced maintenance contracts", () => {
		expect(routeMultiSourceQuery({ tenantId: "tenant", query: "q", sources: [{ id: "bad", tenantId: "other", priority: 9, healthy: true }, { id: "source", tenantId: "tenant", priority: 1, healthy: true }] })).toMatchObject({ sourceIds: ["source"] });
		expect(routeMultiBrainQuery({ tenantId: "tenant", query: "q", brains: [{ id: "brain", tenantId: "tenant", priority: 1, allowed: true }] })).toMatchObject([{ brainId: "brain" }]);
		expect(buildScorecard("score", [{ id: "quality", value: 1, weight: 2 }, { id: "latency", value: 0, weight: 1 }])).toMatchObject({ score: 0.666667 });
		expect(calibrateConfidence([{ confidence: 0.9, correct: true }, { confidence: 0.1, correct: false }], 2).map((bin: { observed: number }) => bin.observed)).toEqual([0, 1]);
		const memories = [{ id: "one", tenantId: "tenant", brainId: "brain", text: "local brain" }, { id: "two", tenantId: "other", brainId: "brain", text: "local brain" }];
		expect(recallMemories(memories, { tenantId: "tenant", brainId: "brain", query: "brain" })).toMatchObject([{ id: "one" }]);
		expect(forgetMemory(memories, { tenantId: "tenant", brainId: "brain", id: "one" })[0]?.forgottenAt).toBeDefined();
		expect(brainstormIdeas({ query: "retrieval", maximum: 2 })).toEqual(["Investigate retrieval", "Prototype retrieval"]);
		expect(captureContributorQuery({ id: "capture", tenantId: "tenant", brainId: "brain", query: "q", consent: false }).status).toBe("pending-consent");
		expect(diagnoseRetrieval({ query: "q", tenantId: "tenant", brainId: "brain", candidates: [{ tenantId: "tenant", brainId: "brain", verified: false }, { tenantId: "other", brainId: "brain", verified: true }] })).toMatchObject({ candidateCount: 1, verifiedCount: 0 });
	});

	test("replays the isolated evaluation corpus and keeps maintenance proposals unapplied", () => {
		const report = evaluationModule.runAdvancedEvaluation();
		expect(report).toMatchObject({ corpus: "gbrain-v0.42.65.0-synthetic", cases: 4, isolated: true });
		expect(report.replay.recall).toBeGreaterThan(0);
		expect(evaluationModule.discoverAdvancedFeatures().map((feature) => feature.id)).toContain("longmemeval-replay");
		expect(evaluationModule.proposeSelfMaintenance({ tenantId: "tenant", brainId: "brain", findings: ["orphan chunks"], dryRun: true })).toMatchObject({ dryRun: true, proposals: [{ requiresApproval: true }] });
	});
});
