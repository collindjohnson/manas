export interface RankedCandidate {
	id: string;
	documentId: string;
	path: string;
	text: string;
	graphBoost?: number;
	sourceTier?: number;
	recencyScore?: number;
	pageStrength?: number;
}

export interface HybridResult extends RankedCandidate {
	score: number;
	lexicalRank?: number;
	semanticRank?: number;
	explain: {
		lexicalScore: number;
		semanticScore: number;
		graphBoost: number;
		sourceTier: number;
		recencyScore: number;
		pageStrength: number;
	};
}

export async function rerankCandidates<T extends RankedCandidate>(provider: { rerank(query: string, documents: Array<{ id: string; text: string }>): Promise<Array<{ id: string; score: number }>> }, query: string, candidates: T[]): Promise<Array<T & { rerankerScore: number }>> {
	if (!query.trim() || !candidates.length || candidates.length > 128 || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) throw new Error("invalid reranker candidates");
	const scores = await provider.rerank(query, candidates.map((candidate) => ({ id: candidate.id, text: candidate.text })));
	if (scores.length !== candidates.length || new Set(scores.map((score) => score.id)).size !== candidates.length || scores.some((score) => typeof score.score !== "number" || !Number.isFinite(score.score) || !candidates.some((candidate) => candidate.id === score.id))) throw new Error("reranker provider returned an invalid response");
	const byId = new Map(scores.map((score) => [score.id, score.score]));
	return candidates.map((candidate) => ({ ...candidate, rerankerScore: byId.get(candidate.id)! })).sort((left, right) => right.rerankerScore - left.rerankerScore || left.path.localeCompare(right.path) || left.documentId.localeCompare(right.documentId) || left.id.localeCompare(right.id));
}

const localExpansionTerms: Record<string, string[]> = {
	"ai": ["artificial intelligence"],
	"llm": ["language model"],
	"db": ["database"],
	"docs": ["documentation"],
	"repo": ["repository"],
	"sync": ["synchronization"],
};

export function expandLocalQuery(query: string, maximumVariants = 8): string[] {
	if (!Number.isInteger(maximumVariants) || maximumVariants < 1 || maximumVariants > 32) throw new Error("invalid query expansion limit");
	const normalized = query.trim().split(" ").filter(Boolean).join(" ");
	if (!normalized) return [];
	const tokens = normalized.split(" ");
	const variants = new Set<string>([normalized]);
	for (const [index, token] of tokens.entries()) {
		for (const replacement of localExpansionTerms[token.toLowerCase()] ?? []) {
			const copy = [...tokens];
			copy[index] = replacement;
			variants.add(copy.join(" "));
			if (variants.size >= maximumVariants) return [...variants];
		}
	}
	return [...variants];
}

function rankMap(candidates: RankedCandidate[]): Map<string, { candidate: RankedCandidate; rank: number }> {
	const result = new Map<string, { candidate: RankedCandidate; rank: number }>();
	candidates.forEach((candidate, index) => {
		if (!result.has(candidate.documentId)) result.set(candidate.documentId, { candidate, rank: index + 1 });
	});
	return result;
}

export function reciprocalRankFusion(lexical: RankedCandidate[], semantic: RankedCandidate[], constant = 60): HybridResult[] {
	if (!Number.isInteger(constant) || constant < 1) throw new Error("invalid RRF constant");
	const left = rankMap(lexical);
	const right = rankMap(semantic);
	const ids = new Set([...left.keys(), ...right.keys()]);
	return [...ids].map((documentId) => {
		const lexicalItem = left.get(documentId);
		const semanticItem = right.get(documentId);
		const candidate = { ...(lexicalItem?.candidate ?? semanticItem!.candidate), graphBoost: Math.max(lexicalItem?.candidate.graphBoost ?? 0, semanticItem?.candidate.graphBoost ?? 0), sourceTier: Math.max(lexicalItem?.candidate.sourceTier ?? 0, semanticItem?.candidate.sourceTier ?? 0), recencyScore: Math.max(lexicalItem?.candidate.recencyScore ?? 0, semanticItem?.candidate.recencyScore ?? 0), pageStrength: Math.max(lexicalItem?.candidate.pageStrength ?? 0, semanticItem?.candidate.pageStrength ?? 0) };
		const lexicalScore = lexicalItem ? 1 / (constant + lexicalItem.rank) : 0;
		const semanticScore = semanticItem ? 1 / (constant + semanticItem.rank) : 0;
		const graphBoost = candidate.graphBoost ?? 0;
		const sourceTier = candidate.sourceTier ?? 0;
		const recencyScore = candidate.recencyScore ?? 0;
		const pageStrength = candidate.pageStrength ?? 0;
		return { ...candidate, score: lexicalScore + semanticScore + graphBoost + sourceTier + recencyScore + pageStrength, lexicalRank: lexicalItem?.rank, semanticRank: semanticItem?.rank, explain: { lexicalScore, semanticScore, graphBoost, sourceTier, recencyScore, pageStrength } };
	}).sort((leftResult, rightResult) => rightResult.score - leftResult.score || leftResult.path.localeCompare(rightResult.path) || leftResult.documentId.localeCompare(rightResult.documentId));
}

export function autocutHybridResults<T extends { score: number }>(results: T[], options: { minimum?: number; maximum?: number; dropAfterRelativeGap?: number } = {}): T[] {
	const minimum = options.minimum ?? 1;
	const maximum = options.maximum ?? 20;
	const gap = options.dropAfterRelativeGap ?? 0.5;
	if (!Number.isInteger(minimum) || minimum < 1 || !Number.isInteger(maximum) || maximum < minimum || maximum > 1_000 || !Number.isFinite(gap) || gap < 0 || gap > 1) throw new Error("invalid autocut options");
	if (!results.length) return [];
	const bounded = results.slice(0, maximum);
	let cutoff = bounded.length;
	for (let index = minimum; index < bounded.length; index++) {
		const previous = bounded[index - 1]!.score;
		const current = bounded[index]!.score;
		if (previous > 0 && (previous - current) / previous >= gap) { cutoff = index; break; }
	}
	return bounded.slice(0, Math.max(minimum, cutoff)).filter((result) => Number.isFinite(result.score));
}
