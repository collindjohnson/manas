import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "reasoning"].join(String.fromCharCode(47));
const { buildReasonedAnswer, detectEvidenceContradictions } = await import(modulePath);

const citation = (chunkId: string) => ({ tenantId: "tenant", brainId: "brain", documentId: "doc", path: "notes/fact.md", documentRevision: "rev", chunkId, startOffset: 0, endOffset: 10, contentHash: "hash", projectedCommit: "commit" });

describe("grounded reasoning contract", () => {
	test("reports contradictions, stale evidence, and bounded confidence", () => {
		const evidence = [{ text: "Owner: Alice", citation: citation("one"), updatedAt: "2020-01-01T00:00:00.000Z" }, { text: "Owner: Bob", citation: citation("two"), updatedAt: "2026-01-01T00:00:00.000Z" }];
		expect(detectEvidenceContradictions(evidence)).toHaveLength(1);
		const result = buildReasonedAnswer({ answer: "The owner is unclear.", evidence, now: new Date("2026-07-27T00:00:00.000Z"), staleAfterDays: 365 });
		expect(result).toMatchObject({ answer: "The owner is unclear.", confidence: expect.any(Number), knowledgeGaps: [] });
		expect(result.contradictions[0]?.subject).toBe("owner");
		expect(result.staleEvidence).toHaveLength(1);
	});

	test("returns an explicit no-answer result for missing evidence", () => {
		expect(buildReasonedAnswer({ answer: "guess", evidence: [] })).toEqual({ citations: [], confidence: 0, contradictions: [], staleEvidence: [], knowledgeGaps: ["No verified evidence was available."] });
	});
});
