export interface CodeSymbol {
	id: string;
	name: string;
	kind: "function" | "class" | "variable" | "type";
	path: string;
	startOffset: number;
	endOffset: number;
}

export interface CodeEdge {
	from: string;
	to: string;
	type: "reference" | "calls" | "documents";
	path: string;
}

export interface CodeAnalysis {
	symbols: CodeSymbol[];
	edges: CodeEdge[];
}

export function analyzeCodeDocument(path: string, content: string): CodeAnalysis {
	if (!path.trim() || path.includes("\0")) throw new Error("invalid code path");
	const symbols: CodeSymbol[] = [];
	const definition = /\b(function|class|const|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/g;
	for (const match of content.matchAll(definition)) {
		const kind = match[1] === "function" ? "function" : match[1] === "class" ? "class" : match[1] === "interface" || match[1] === "type" ? "type" : "variable";
		const name = match[2]!;
		const startOffset = match.index ?? 0;
		symbols.push({ id: path + ":" + name + ":" + startOffset, name, kind, path, startOffset, endOffset: startOffset + match[0].length });
	}
	const known = new Map(symbols.map((symbol) => [symbol.name, symbol]));
	const edges: CodeEdge[] = [];
	const calls = /\b([A-Za-z_$][\w$]*)\s*\(/g;
	for (const match of content.matchAll(calls)) {
		const name = match[1]!;
		if (["if", "for", "while", "switch", "catch", "function"].includes(name)) continue;
		const symbol = known.get(name);
		if (symbol) edges.push({ from: symbol.id, to: symbol.id, type: "calls", path });
	}
	for (const symbol of symbols) {
		const safeName = symbol.name.replaceAll("$", "\\$");
		const occurrences = [...content.matchAll(new RegExp("\\b" + safeName + "\\b", "g"))];
		if (occurrences.length > 1) edges.push({ from: symbol.id, to: symbol.id, type: "reference", path });
	}
	return { symbols, edges };
}

export function linkDocumentation(path: string, markdown: string, code: CodeAnalysis): CodeEdge[] {
	const names = new Set(code.symbols.map((symbol) => symbol.name));
	return [...names].filter((name) => markdown.includes(name)).map((name) => ({ from: path, to: code.symbols.find((symbol) => symbol.name === name)!.id, type: "documents" as const, path }));
}

export interface TrajectoryEvent { id: string; at: string; label: string; metadata?: Record<string, string>; }
export interface Trajectory { id: string; events: TrajectoryEvent[]; startAt?: string; endAt?: string; }

export function buildTrajectory(id: string, events: TrajectoryEvent[], maximumEvents = 1_000): Trajectory {
	if (!id.trim() || !Number.isInteger(maximumEvents) || maximumEvents < 1 || maximumEvents > 10_000) throw new Error("invalid trajectory");
	const ordered = [...events].sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id)).slice(0, maximumEvents);
	if (ordered.some((event) => !event.id.trim() || !event.label.trim() || Number.isNaN(Date.parse(event.at)))) throw new Error("invalid trajectory event");
	return { id, events: ordered, startAt: ordered[0]?.at, endAt: ordered.at(-1)?.at };
}

export interface EvaluationCase { id: string; expectedIds: string[]; actualIds: string[]; }
export interface EvaluationReport { cases: number; exactMatches: number; recall: number; precision: number; }

export function replayEvaluation(cases: EvaluationCase[]): EvaluationReport {
	if (cases.some((item) => !item.id.trim() || new Set(item.actualIds).size !== item.actualIds.length)) throw new Error("invalid evaluation case");
	let exactMatches = 0;
	let expected = 0;
	let retrieved = 0;
	let hits = 0;
	for (const item of cases) {
		const expectedIds = new Set(item.expectedIds);
		const actualIds = new Set(item.actualIds);
		if (item.expectedIds.length === item.actualIds.length && item.expectedIds.every((id, index) => id === item.actualIds[index])) exactMatches += 1;
		expected += expectedIds.size;
		retrieved += actualIds.size;
		hits += [...actualIds].filter((id) => expectedIds.has(id)).length;
	}
	return { cases: cases.length, exactMatches, recall: expected ? hits / expected : 0, precision: retrieved ? hits / retrieved : 0 };
}

export interface SourceRoute { id: string; tenantId: string; priority: number; healthy: boolean; }
export interface BrainRoute { id: string; tenantId: string; priority: number; allowed: boolean; }
export interface QueryRoute { tenantId: string; brainId?: string; sourceIds?: string[]; query: string; }

export function routeMultiSourceQuery(input: { tenantId: string; query: string; sources: SourceRoute[]; maximumSources?: number }): QueryRoute {
	const maximum = input.maximumSources ?? 8;
	if (!input.tenantId.trim() || !input.query.trim() || !Number.isInteger(maximum) || maximum < 1 || maximum > 100) throw new Error("invalid source route");
	const sources = input.sources.filter((source) => source.tenantId === input.tenantId && source.healthy).sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id)).slice(0, maximum);
	return { tenantId: input.tenantId, sourceIds: sources.map((source) => source.id), query: input.query.trim() };
}

export function routeMultiBrainQuery(input: { tenantId: string; query: string; brains: BrainRoute[]; maximumBrains?: number }): QueryRoute[] {
	const maximum = input.maximumBrains ?? 8;
	if (!input.tenantId.trim() || !input.query.trim() || !Number.isInteger(maximum) || maximum < 1 || maximum > 100) throw new Error("invalid brain route");
	return input.brains.filter((brain) => brain.tenantId === input.tenantId && brain.allowed).sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id)).slice(0, maximum).map((brain) => ({ tenantId: input.tenantId, brainId: brain.id, query: input.query.trim() }));
}

export interface ScorecardMetric { id: string; value: number; weight: number; }
export interface Scorecard { id: string; score: number; metrics: ScorecardMetric[]; }

export function buildScorecard(id: string, metrics: ScorecardMetric[]): Scorecard {
	if (!id.trim() || !metrics.length || metrics.some((metric) => !metric.id.trim() || !Number.isFinite(metric.value) || metric.value < 0 || metric.value > 1 || !Number.isFinite(metric.weight) || metric.weight < 0)) throw new Error("invalid scorecard");
	const totalWeight = metrics.reduce((total, metric) => total + metric.weight, 0);
	if (totalWeight <= 0) throw new Error("scorecard requires positive weight");
	const normalized = [...metrics].sort((left, right) => left.id.localeCompare(right.id));
	return { id, metrics: normalized, score: Number((normalized.reduce((total, metric) => total + metric.value * metric.weight, 0) / totalWeight).toFixed(6)) };
}

export interface CalibrationBin { lower: number; upper: number; cases: number; correct: number; observed: number; }

export function calibrateConfidence(values: Array<{ confidence: number; correct: boolean }>, bins = 10): CalibrationBin[] {
	if (!Number.isInteger(bins) || bins < 1 || bins > 100 || values.some((value) => !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)) throw new Error("invalid confidence calibration");
	const result = Array.from({ length: bins }, (_, index) => ({ lower: index / bins, upper: (index + 1) / bins, cases: 0, correct: 0, observed: 0 }));
	for (const value of values) { const index = Math.min(bins - 1, Math.floor(value.confidence * bins)); const bin = result[index]!; bin.cases += 1; if (value.correct) bin.correct += 1; }
	for (const bin of result) bin.observed = bin.cases ? Number((bin.correct / bin.cases).toFixed(6)) : 0;
	return result;
}

export interface MemoryRecord { id: string; tenantId: string; brainId: string; text: string; forgottenAt?: string; }

export function recallMemories(records: MemoryRecord[], input: { tenantId: string; brainId: string; query: string; limit?: number }): MemoryRecord[] {
	const limit = input.limit ?? 20;
	if (!input.tenantId.trim() || !input.brainId.trim() || !input.query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid memory recall");
	const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
	return records.filter((record) => record.tenantId === input.tenantId && record.brainId === input.brainId && !record.forgottenAt).map((record) => ({ record, score: terms.filter((term) => record.text.toLowerCase().includes(term)).length })).filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id)).slice(0, limit).map((candidate) => candidate.record);
}

export function forgetMemory(records: MemoryRecord[], input: { tenantId: string; brainId: string; id: string; now?: Date }): MemoryRecord[] {
	if (!input.tenantId.trim() || !input.brainId.trim() || !input.id.trim()) throw new Error("invalid memory forget");
	const found = records.some((record) => record.id === input.id && record.tenantId === input.tenantId && record.brainId === input.brainId);
	if (!found) throw new Error("memory is not in the requested scope");
	return records.map((record) => record.id === input.id ? { ...record, forgottenAt: (input.now ?? new Date()).toISOString() } : { ...record });
}

export function brainstormIdeas(input: { query: string; context?: string[]; maximum?: number }): string[] {
	const maximum = input.maximum ?? 8;
	if (!input.query.trim() || !Number.isInteger(maximum) || maximum < 1 || maximum > 32) throw new Error("invalid brainstorming request");
	const context = (input.context ?? []).filter((item) => item.trim()).slice(0, 8);
	return [...new Set([`Investigate ${input.query.trim()}`, `Prototype ${input.query.trim()}`, `Measure the risks of ${input.query.trim()}`, ...context.map((item) => `Connect ${item} to ${input.query.trim()}`)])].slice(0, maximum);
}

export interface ContributorCapture { id: string; tenantId: string; brainId: string; query: string; status: "pending-consent" | "accepted" | "rejected"; }

export function captureContributorQuery(input: { id: string; tenantId: string; brainId: string; query: string; consent: boolean }): ContributorCapture {
	if (!input.id.trim() || !input.tenantId.trim() || !input.brainId.trim() || !input.query.trim()) throw new Error("invalid contributor capture");
	return { id: input.id, tenantId: input.tenantId, brainId: input.brainId, query: input.query.trim(), status: input.consent ? "accepted" : "pending-consent" };
}

export interface RetrievalDiagnostic { query: string; candidateCount: number; verifiedCount: number; tenantId: string; brainId: string; warnings: string[]; }

export function diagnoseRetrieval(input: { query: string; tenantId: string; brainId: string; candidates: Array<{ tenantId: string; brainId: string; verified: boolean }> }): RetrievalDiagnostic {
	if (!input.query.trim() || !input.tenantId.trim() || !input.brainId.trim()) throw new Error("invalid retrieval diagnostic");
	const scoped = input.candidates.filter((candidate) => candidate.tenantId === input.tenantId && candidate.brainId === input.brainId);
	return { query: input.query.trim(), candidateCount: scoped.length, verifiedCount: scoped.filter((candidate) => candidate.verified).length, tenantId: input.tenantId, brainId: input.brainId, warnings: scoped.some((candidate) => !candidate.verified) ? ["unverified candidates were excluded from grounded reasoning"] : [] };
}

export interface AnomalyRecord { id: string; tenantId: string; brainId: string; baseline: number; observed: number; threshold?: number; metadata?: Record<string, string>; }
export interface DetectedAnomaly { id: string; tenantId: string; brainId: string; delta: number; severity: "warning" | "critical"; metadata: Record<string, string>; }

export function detectAnomalies(records: AnomalyRecord[]): DetectedAnomaly[] {
	if (records.some((record) => !record.id.trim() || !record.tenantId.trim() || !record.brainId.trim() || !Number.isFinite(record.baseline) || !Number.isFinite(record.observed) || record.threshold !== undefined && (!Number.isFinite(record.threshold) || record.threshold < 0))) throw new Error("invalid anomaly record");
	return records.map((record) => ({ record, delta: Math.abs(record.observed - record.baseline) })).filter(({ record, delta }) => delta > (record.threshold ?? 0)).sort((left, right) => right.delta - left.delta || left.record.id.localeCompare(right.record.id)).map(({ record, delta }) => ({ id: record.id, tenantId: record.tenantId, brainId: record.brainId, delta, severity: delta >= Math.max(record.threshold ?? 0, 1) * 2 ? "critical" : "warning", metadata: { ...(record.metadata ?? {}) } }));
}
