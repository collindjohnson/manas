import type { Database } from "bun:sqlite";
import type { Config } from "@manas/config";
import { cosineSimilarity, deserializeVector, normalizeVector, serializeVector } from "@manas-brain-vector";
import { modelFingerprint, OpenAiCompatibleEmbeddingProvider, type EmbeddingProvider } from "@manas-brain-providers";

export interface LocalArchiveRow {
	chunk_id: string;
	text: string;
	manas_id: string;
	relative_path: string;
	title?: string;
	provider: string;
	project?: string;
	repository?: string;
	workspace?: string;
	role?: "user" | "assistant";
	created_at?: string;
	updated_at?: string;
}

export interface LocalArchiveEmbeddingHit {
	row: LocalArchiveRow;
	score: number;
}

export function archiveEmbeddingModelIdentity(provider: EmbeddingProvider): string {
	return provider.model.fingerprint ?? `${provider.model.id}:${provider.model.dimensions}`;
}

export function configuredArchiveEmbeddingProvider(config: Config): EmbeddingProvider | undefined {
	const configured = config.providers?.embedding;
	if (!configured) return undefined;
	if (configured.dimensions === undefined) throw new Error("configured embedding provider dimensions are required");
	const descriptor = {
		kind: "embedding" as const,
		provider: configured.provider ?? "openai-compatible",
		model: configured.model,
		revision: configured.revision,
		dimensions: configured.dimensions,
		privacy: configured.privacy,
	};
	const model = {
		id: configured.model,
		dimensions: configured.dimensions,
		fingerprint: modelFingerprint(descriptor),
	};
	return new OpenAiCompatibleEmbeddingProvider(
		model,
		configured.endpoint,
		configured.apiKey,
		configured.privacy,
		{ timeoutMs: config.brain?.requestTimeoutMs },
	);
}

export async function indexArchiveEmbeddings(
	database: Database,
	provider: EmbeddingProvider,
	batchSize = 32,
): Promise<{ embedded: number; model: string; dimensions: number }> {
	if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("invalid embedding batch size");
	const model = archiveEmbeddingModelIdentity(provider);
	const rows = database.prepare(
		"SELECT c.id, c.text FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM local_chunk_embeddings e WHERE e.chunk_id = c.id AND e.model_fingerprint = ? AND e.dimensions = ?) ORDER BY c.id",
	).all(model, provider.model.dimensions) as Array<{ id: string; text: string }>;
	let embedded = 0;
	for (let start = 0; start < rows.length; start += batchSize) {
		const batch = rows.slice(start, start + batchSize);
		const vectors = await provider.embed(batch.map((row) => row.text));
		if (vectors.length !== batch.length) throw new Error("embedding provider returned an invalid batch");
		const insert = database.prepare(
			"INSERT OR REPLACE INTO local_chunk_embeddings (chunk_id, model_fingerprint, dimensions, embedding, created_at) VALUES (?, ?, ?, ?, ?)",
		);
		for (const [index, row] of batch.entries()) {
			const vector = vectors[index];
			if (!vector || vector.length !== provider.model.dimensions) throw new Error("embedding provider returned an invalid vector");
			insert.run(row.id, model, provider.model.dimensions, serializeVector(normalizeVector(vector)), new Date().toISOString());
			embedded += 1;
		}
	}
	return { embedded, model, dimensions: provider.model.dimensions };
}

export async function searchArchiveEmbeddings(
	database: Database,
	provider: EmbeddingProvider,
	query: string,
	limit: number,
	filters: {
		provider?: string;
		project?: string;
		repository?: string;
		workspace?: string;
		role?: "user" | "assistant";
		after?: string;
		before?: string;
	},
): Promise<LocalArchiveEmbeddingHit[]> {
	const [rawVector] = await provider.embed([query]);
	if (!rawVector || rawVector.length !== provider.model.dimensions) throw new Error("embedding provider returned an invalid vector");
	const queryVector = normalizeVector(rawVector);
	const clauses = ["e.model_fingerprint = ?", "e.dimensions = ?"];
	const values: Array<string | number> = [archiveEmbeddingModelIdentity(provider), provider.model.dimensions];
	for (const [column, value] of [
		["d.provider", filters.provider],
		["d.project", filters.project],
		["d.repository", filters.repository],
		["d.workspace", filters.workspace],
		["c.role", filters.role],
	] as const) {
		if (value) {
			clauses.push(`${column} = ?`);
			values.push(value);
		}
	}
	if (filters.after) {
		clauses.push("COALESCE(d.updated_at, d.created_at, '') >= ?");
		values.push(filters.after);
	}
	if (filters.before) {
		clauses.push("COALESCE(d.updated_at, d.created_at, '') <= ?");
		values.push(filters.before);
	}
	const rows = database.prepare(
		`SELECT c.id AS chunk_id, c.text, d.manas_id, d.relative_path, d.title, d.provider, d.project, d.repository, d.workspace, c.role, d.created_at, d.updated_at, e.embedding, e.dimensions FROM local_chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.manas_id = c.document_id WHERE ${clauses.join(" AND ")}`,
	).all(...values) as Array<LocalArchiveRow & { embedding: Uint8Array; dimensions: number }>;
	return rows
		.map(({ embedding, dimensions, ...row }) => ({ row, score: cosineSimilarity(queryVector, deserializeVector(embedding, dimensions)) }))
		.sort((left, right) => right.score - left.score || left.row.relative_path.localeCompare(right.row.relative_path) || left.row.chunk_id.localeCompare(right.row.chunk_id))
		.slice(0, limit);
}

export function countArchiveEmbeddings(database: Database, provider: EmbeddingProvider): number {
	return Number((database.prepare(
		"SELECT COUNT(*) AS count FROM local_chunk_embeddings WHERE model_fingerprint = ? AND dimensions = ?",
	).get(archiveEmbeddingModelIdentity(provider), provider.model.dimensions) as { count: number }).count);
}
