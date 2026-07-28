export interface VerifiedCitation {
	tenantId: string;
	brainId: string;
	documentId: string;
	path: string;
	documentRevision: string;
	chunkId: string;
	startOffset: number;
	endOffset: number;
	contentHash: string;
	projectedCommit: string;
}

export interface ReasoningEvidence {
	text: string;
	citation: VerifiedCitation;
	updatedAt?: string;
}

export interface Contradiction {
	subject: string;
	claims: Array<{ text: string; citation: VerifiedCitation }>;
}

export interface StaleEvidence {
	citation: VerifiedCitation;
	updatedAt?: string;
	ageDays: number;
}

export interface ReasonedAnswer {
	answer?: string;
	citations: VerifiedCitation[];
	confidence: number;
	contradictions: Contradiction[];
	staleEvidence: StaleEvidence[];
	knowledgeGaps: string[];
}

function claimKey(text: string): string | undefined {
	const match = text.match(/^\s*([^:\n]{1,120})\s*:\s*(.+)$/) ?? text.match(/^\s*([^=\n]{1,120})\s*=\s*(.+)$/);
	return match?.[1]?.trim().toLowerCase();
}

function claimValue(text: string): string {
	const separator = text.indexOf(":") >= 0 ? text.indexOf(":") : text.indexOf("=");
	return (separator >= 0 ? text.slice(separator + 1) : text).trim();
}

function ageDays(updatedAt: string | undefined, now: Date): number {
	if (!updatedAt) return 0;
	const timestamp = Date.parse(updatedAt);
	if (Number.isNaN(timestamp)) return 0;
	return Math.max(0, (now.getTime() - timestamp) / 86_400_000);
}

export function detectEvidenceContradictions(evidence: ReasoningEvidence[]): Contradiction[] {
	const claims = new Map<string, Array<{ text: string; citation: VerifiedCitation }>>();
	for (const item of evidence) {
		const key = claimKey(item.text);
		if (!key) continue;
		const current = claims.get(key) ?? [];
		if (!current.some((claim) => claim.text === item.text)) current.push({ text: item.text, citation: item.citation });
		claims.set(key, current);
	}
	return [...claims.entries()].filter(([, values]) => new Set(values.map((value) => claimValue(value.text))).size > 1).map(([subject, claims]) => ({ subject, claims }));
}

export function buildReasonedAnswer(input: { answer?: string; evidence: ReasoningEvidence[]; knowledgeGaps?: string[]; now?: Date; staleAfterDays?: number }): ReasonedAnswer {
	const now = input.now ?? new Date();
	const staleAfterDays = input.staleAfterDays ?? 365;
	if (!Number.isInteger(staleAfterDays) || staleAfterDays < 1) throw new Error("invalid stale evidence threshold");
	const citations = [...new Map(input.evidence.map((item) => [item.citation.chunkId, item.citation])).values()];
	const staleEvidence = input.evidence.filter((item) => ageDays(item.updatedAt, now) >= staleAfterDays).map((item) => ({ citation: item.citation, ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}), ageDays: ageDays(item.updatedAt, now) }));
	const contradictions = detectEvidenceContradictions(input.evidence);
	const knowledgeGaps = [...new Set((input.knowledgeGaps ?? []).filter((gap) => gap.trim()))];
	if (!input.evidence.length) return { citations: [], confidence: 0, contradictions: [], staleEvidence: [], knowledgeGaps: knowledgeGaps.length ? knowledgeGaps : ["No verified evidence was available."] };
	const coverage = input.answer?.trim() ? Math.min(1, citations.length / Math.max(1, input.evidence.length)) : 0;
	const freshness = Math.max(0, 1 - staleEvidence.length / input.evidence.length);
	const contradictionPenalty = Math.min(0.5, contradictions.length * 0.15);
	const confidence = Math.max(0, Math.min(1, Number((coverage * 0.6 + freshness * 0.4 - contradictionPenalty).toFixed(6))));
	return { ...(input.answer?.trim() ? { answer: input.answer } : {}), citations, confidence, contradictions, staleEvidence, knowledgeGaps };
}
