import type { Config } from "../config";
import type { SearchOptions, SearchOutcome, SearchResult } from "../model";
import { openBrainDatabase } from "./database";
import { graphContributions } from "./graph";
import {
	createZeroEntropyClient,
	resolveZeroEntropyApiKey,
} from "./zeroentropy";

export const RRF_K = 60;
export const MAX_GRAPH_BOOST = 0.1;

export class SemanticUnavailableError extends Error {}

type Row = {
	chunk_id: string;
	text: string;
	nessie_id: string;
	relative_path: string;
	title?: string;
	provider: string;
	project?: string;
	repository?: string;
	workspace?: string;
	role?: "user" | "assistant";
	created_at?: string;
	updated_at?: string;
	rank: number;
};
type Candidate = {
	row: Row;
	lexicalRank?: number;
	semanticRank?: number;
	lexical?: number;
	semantic?: number;
};

export function ftsQuery(query: string): string {
	const terms = query.trim().match(/[\p{L}\p{N}_-]+/gu) ?? [];
	if (!terms.length)
		throw new Error("search query must contain letters or numbers");
	return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}
export function validateSearchOptions(options: SearchOptions): void {
	if (options.mode && !["hybrid", "keyword", "semantic"].includes(options.mode))
		throw new Error("mode must be hybrid, keyword, or semantic");
	if (
		options.limit !== undefined &&
		(!Number.isInteger(options.limit) ||
			options.limit < 1 ||
			options.limit > 100)
	)
		throw new Error("limit must be an integer between 1 and 100");
	if (options.role && options.role !== "user" && options.role !== "assistant")
		throw new Error("role must be user or assistant");
	for (const [name, value] of Object.entries({
		after: options.after,
		before: options.before,
	}))
		if (
			value &&
			(Number.isNaN(Date.parse(value)) ||
				!/^\d{4}-\d{2}-\d{2}(?:T|\s)/.test(value))
		)
			throw new Error(`${name} must be a valid ISO-8601 date`);
	if (
		options.after &&
		options.before &&
		Date.parse(options.after) > Date.parse(options.before)
	)
		throw new Error("after must be no later than before");
}
function matches(row: Row, options: SearchOptions): boolean {
	const date = row.updated_at ?? row.created_at ?? "";
	return (
		(!options.provider || row.provider === options.provider) &&
		(!options.project || row.project === options.project) &&
		(!options.repository || row.repository === options.repository) &&
		(!options.workspace || row.workspace === options.workspace) &&
		(!options.role || row.role === options.role) &&
		(!options.after || date >= options.after) &&
		(!options.before || date <= options.before)
	);
}
function lexicalRows(
	database: Awaited<ReturnType<typeof openBrainDatabase>>,
	query: string,
	limit: number,
	options: SearchOptions,
): Row[] {
	const clauses = ["chunks_fts MATCH ?"];
	const values: Array<string | number> = [ftsQuery(query)];
	for (const [column, value] of [
		["d.provider", options.provider],
		["d.project", options.project],
		["d.repository", options.repository],
		["d.workspace", options.workspace],
		["c.role", options.role],
	] as const)
		if (value) {
			clauses.push(`${column} = ?`);
			values.push(value);
		}
	if (options.after) {
		clauses.push("COALESCE(d.updated_at, d.created_at, '') >= ?");
		values.push(options.after);
	}
	if (options.before) {
		clauses.push("COALESCE(d.updated_at, d.created_at, '') <= ?");
		values.push(options.before);
	}
	values.push(limit);
	return database
		.prepare(
			`SELECT c.id AS chunk_id, c.text, d.nessie_id, d.relative_path, d.title, d.provider, d.project, d.repository, d.workspace, c.role, d.created_at, d.updated_at, bm25(chunks_fts) AS rank FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.chunk_id JOIN documents d ON d.nessie_id = c.document_id WHERE ${clauses.join(" AND ")} ORDER BY rank, c.id LIMIT ?`,
		)
		.all(...values) as Row[];
}
function excerpt(text: string, query: string, maximum: number): string {
	if (text.length <= maximum) return text;
	const term = (query.match(/[\p{L}\p{N}_-]+/u)?.[0] ?? "").toLowerCase();
	const found = text.toLowerCase().indexOf(term);
	const start = Math.max(0, (found < 0 ? 0 : found) - Math.floor(maximum / 3));
	return `${start ? "…" : ""}${text.slice(start, start + maximum).trim()}${start + maximum < text.length ? "…" : ""}`;
}
function normalized(
	value: number | undefined,
	values: number[],
): number | undefined {
	if (value === undefined || !values.length) return undefined;
	const min = Math.min(...values),
		max = Math.max(...values);
	return max === min ? 1 : (value - min) / (max - min);
}
function metadataFilter(
	options: SearchOptions,
): Record<string, { $eq: string }> | undefined {
	const entries = Object.entries({
		provider: options.provider,
		project: options.project,
		repository: options.repository,
		workspace: options.workspace,
	}).filter(([, value]) => value !== undefined) as Array<[string, string]>;
	return entries.length
		? Object.fromEntries(entries.map(([key, value]) => [key, { $eq: value }]))
		: undefined;
}

export async function searchArchiveOutcome(
	config: Config,
	query: string,
	options: SearchOptions = {},
): Promise<SearchOutcome> {
	const requestedMode = options.mode ?? "hybrid";
	try {
		const { results, degradation } = await searchInternal(
			config,
			query,
			options,
		);
		return {
			results,
			requestedMode,
			effectiveMode: degradation
				? requestedMode === "semantic"
					? "unavailable"
					: "keyword-degraded"
				: requestedMode,
			degraded: Boolean(degradation),
			diagnostics: degradation ? [degradation] : [],
		};
	} catch (error) {
		if (error instanceof SemanticUnavailableError)
			return {
				results: [],
				requestedMode,
				effectiveMode: "unavailable",
				degraded: true,
				diagnostics: [error.message],
			};
		throw error;
	}
}
export async function searchArchive(
	config: Config,
	query: string,
	options: SearchOptions = {},
): Promise<SearchResult[]> {
	return (await searchInternal(config, query, options)).results;
}
async function searchInternal(
	config: Config,
	query: string,
	options: SearchOptions,
): Promise<{ results: SearchResult[]; degradation?: string }> {
	const brain = config.brain;
	if (!brain) throw new Error("brain configuration is unavailable");
	validateSearchOptions(options);
	const mode = options.mode ?? "hybrid";
	const limit = options.limit ?? brain.retrievalLimit;
	const candidateLimit = Math.min(128, limit * (brain.remoteOversample ?? 4));
	const database = await openBrainDatabase(brain.databasePath);
	try {
		const semanticTask =
			mode === "keyword"
				? Promise.resolve({
						items: [] as Array<{ row: Row; score: number }>,
						degradation: undefined as string | undefined,
					})
				: (async () => {
						const key = await resolveZeroEntropyApiKey(
							brain.keychainService,
							brain.keychainAccount,
						);
						if (!key)
							return {
								items: [],
								degradation:
									"semantic search is unavailable: ZeroEntropy credential is not configured",
							};
						try {
							const remote = await createZeroEntropyClient({
								baseUrl: brain.zeroEntropyBaseUrl,
								collection: brain.zeroEntropyCollection,
								apiKey: key,
								timeoutMs: brain.requestTimeoutMs,
								retryAttempts: brain.retryAttempts,
								retryBackoffMs: brain.retryBackoffMs,
							}).search(query, candidateLimit, metadataFilter(options));
							const get = database.prepare(
								"SELECT c.id AS chunk_id, c.text, d.nessie_id, d.relative_path, d.title, d.provider, d.project, d.repository, d.workspace, c.role, d.created_at, d.updated_at, 0 AS rank FROM chunks c JOIN documents d ON d.nessie_id = c.document_id WHERE c.id = ?",
							);
							return {
								items: remote.flatMap((item) => {
									const row = get.get(item.id) as Row | null;
									return row && matches(row, options)
										? [{ row, score: item.score }]
										: [];
								}),
								degradation: undefined,
							};
						} catch (error) {
							return {
								items: [],
								degradation:
									error instanceof Error
										? error.message
										: "semantic search is unavailable",
							};
						}
					})();
		const lexicalTask = Promise.resolve(
			mode === "semantic"
				? []
				: lexicalRows(database, query, candidateLimit, options),
		);
		const [lexical, semantic] = await Promise.all([lexicalTask, semanticTask]);
		if (mode === "semantic" && semantic.degradation)
			throw new SemanticUnavailableError(semantic.degradation);
		const candidates = new Map<string, Candidate>();
		lexical.forEach((row, index) =>
			candidates.set(row.chunk_id, {
				row,
				lexicalRank: index + 1,
				lexical: -row.rank,
			}),
		);
		semantic.items.forEach((item, index) => {
			const prior = candidates.get(item.row.chunk_id);
			candidates.set(item.row.chunk_id, {
				row: item.row,
				lexicalRank: prior?.lexicalRank,
				lexical: prior?.lexical,
				semanticRank: index + 1,
				semantic: item.score,
			});
		});
		const rows = [...candidates.values()];
		const lexicalValues = rows.flatMap((item) =>
			item.lexical === undefined ? [] : [item.lexical],
		);
		const semanticValues = rows.flatMap((item) =>
			item.semantic === undefined ? [] : [item.semantic],
		);
		// Graph relationships are a post-retrieval signal: they cannot introduce a
		// document that lexical/semantic retrieval did not independently return.
		const contributions = graphContributions(database, [
			...new Set(rows.map((item) => item.row.nessie_id)),
		]);
		const scored = rows.map((item) => {
			const unboosted =
				(item.lexicalRank ? 1 / (RRF_K + item.lexicalRank) : 0) +
				(item.semanticRank ? 1 / (RRF_K + item.semanticRank) : 0);
			const facts = contributions.get(item.row.nessie_id) ?? [];
			// Each explicit shared fact contributes a small fixed amount. The cap
			// prevents a densely connected conversation from dominating retrieval.
			const graphBoost = Math.min(MAX_GRAPH_BOOST, facts.length * 0.025);
			return {
				item,
				unboosted,
				graphBoost,
				facts,
				final: unboosted + graphBoost,
			};
		});
		const finalValues = scored.map((item) => item.final);
		const seen = new Set<string>();
		return {
			degradation: semantic.degradation,
			results: scored
				.sort(
					(a, b) =>
						b.final - a.final ||
						(a.item.lexicalRank ?? Number.POSITIVE_INFINITY) -
							(b.item.lexicalRank ?? Number.POSITIVE_INFINITY) ||
						(a.item.semanticRank ?? Number.POSITIVE_INFINITY) -
							(b.item.semanticRank ?? Number.POSITIVE_INFINITY) ||
						a.item.row.nessie_id.localeCompare(b.item.row.nessie_id) ||
						a.item.row.chunk_id.localeCompare(b.item.row.chunk_id),
				)
				.filter(
					({ item }) =>
						!seen.has(item.row.nessie_id) &&
						Boolean(seen.add(item.row.nessie_id)),
				)
				.slice(0, limit)
				.map(({ item, unboosted, graphBoost, facts, final }) => ({
					nessieId: item.row.nessie_id,
					path: item.row.relative_path,
					title: item.row.title,
					provider: item.row.provider,
					chunkId: item.row.chunk_id,
					text: excerpt(item.row.text, query, brain.snippetChars ?? 500),
					score: normalized(final, finalValues) ?? 0,
					lexicalScore: normalized(item.lexical, lexicalValues),
					semanticScore: normalized(item.semantic, semanticValues),
					degraded: Boolean(semantic.degradation),
					degradedReason: semantic.degradation,
					...(options.explain
						? {
								explain: {
									lexicalRank: item.lexicalRank,
									semanticRank: item.semanticRank,
									unboostedScore: unboosted,
									graphBoost,
									graphContributions: facts.map((fact) => ({
										...fact,
										score: facts.length ? graphBoost / facts.length : 0,
									})),
									degradation: semantic.degradation,
								},
							}
						: {}),
				})),
		};
	} finally {
		database.close();
	}
}
