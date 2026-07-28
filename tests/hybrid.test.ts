import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "hybrid"].join(String.fromCharCode(47));
const { autocutHybridResults, expandLocalQuery, reciprocalRankFusion, rerankCandidates } = await import(modulePath);

describe("hybrid reciprocal rank fusion", () => {
	test("expands local query aliases deterministically without a provider", () => {
		expect(expandLocalQuery("sync the repo")).toEqual(["sync the repo", "synchronization the repo", "sync the repository"]);
		expect(expandLocalQuery("   ")).toEqual([]);
	});

	test("deduplicates documents, applies graph signals, and breaks ties stably", () => {
		const result = reciprocalRankFusion(
			[{ id: "a1", documentId: "a", path: "notes/a.md", text: "a" }, { id: "b1", documentId: "b", path: "notes/b.md", text: "b" }],
			[{ id: "b2", documentId: "b", path: "notes/b.md", text: "b", graphBoost: 0.1 }, { id: "a2", documentId: "a", path: "notes/a.md", text: "a" }],
		);
		expect(result.map((item: any) => item.documentId)).toEqual(["b", "a"]);
		expect(result[0]).toMatchObject({ lexicalRank: 2, semanticRank: 1 });
		expect(result[0]?.explain).toMatchObject({ graphBoost: 0.1 });
	});

	test("uses explainable source and recency signals and applies deterministic autocut", () => {
		const result = reciprocalRankFusion(
			[{ id: "old", documentId: "old", path: "old.md", text: "old", recencyScore: 0.1 }],
			[{ id: "new", documentId: "new", path: "new.md", text: "new", recencyScore: 0.4, sourceTier: 0.2 }],
		);
		expect(result[0]?.documentId).toBe("new");
		expect(autocutHybridResults([{ score: 1 }, { score: 0.1 }, { score: 0.09 }], { minimum: 1, dropAfterRelativeGap: 0.5 })).toHaveLength(1);
	});

	test("applies complete local reranker scores with stable tie breaking", async () => {
		const candidates = [{ id: "a", documentId: "a", path: "notes/a.md", text: "a" }, { id: "b", documentId: "b", path: "notes/b.md", text: "b" }];
		const provider = { rerank: async () => [{ id: "a", score: 0.5 }, { id: "b", score: 0.5 }] };
		expect((await rerankCandidates(provider, "query", candidates)).map((candidate: { id: string }) => candidate.id)).toEqual(["a", "b"]);
		await expect(rerankCandidates({ rerank: async () => [{ id: "a", score: 1 }] }, "query", candidates)).rejects.toThrow("invalid response");
	});
});
