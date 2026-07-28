import { createHash } from "node:crypto";

type Store = {
	query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]>;
	exec(sql: string): Promise<void>;
};

type Provider = { model: { id: string; dimensions: number; fingerprint?: string }; embed(texts: string[]): Promise<number[][]> };
type EmbeddingScope = { tenantId: string; brainId: string; allowedAccessLabels?: string[] };

function vectorLiteral(vector: number[]): string {
	if (!vector.length || vector.some((value) => !Number.isFinite(value))) throw new Error("invalid embedding vector");
	return `[${vector.join(",")}]`;
}

function indexName(modelIdentity: string, dimensions: number): string {
	const suffix = modelIdentity.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 24) || "default";
	const identityHash = createHash("sha256").update(`${modelIdentity}:${dimensions}`).digest("hex").slice(0, 16);
	return `brain_chunks_embedding_hnsw_${suffix}_${identityHash}`;
}

export async function indexLocalEmbeddings(store: Store, provider: Provider, batchSize = 32, scope: EmbeddingScope = { tenantId: "local", brainId: "local" }): Promise<{ embedded: number; model: string; dimensions: number }> {
	if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("invalid embedding batch size");
	if (!scope.tenantId.trim() || !scope.brainId.trim()) throw new Error("invalid embedding scope");
	const modelIdentity = provider.model.fingerprint ?? provider.model.id;
	const rows = await store.query<{ id: string; text: string }>("SELECT c.id, c.text FROM brain_chunks c JOIN brain_documents d ON d.id = c.document_id WHERE d.tenant_id = $2 AND d.brain_id = $3 AND d.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM brain_chunk_embeddings e WHERE e.chunk_id = c.id AND e.tenant_id = $2 AND e.brain_id = $3 AND e.model_fingerprint = $1) ORDER BY c.id", [modelIdentity, scope.tenantId, scope.brainId]);
	let embedded = 0;
	for (let start = 0; start < rows.length; start += batchSize) {
		const batch = rows.slice(start, start + batchSize);
		const vectors = await provider.embed(batch.map((item) => item.text));
		if (vectors.length !== batch.length) throw new Error("embedding provider returned an invalid batch");
		for (const [index, row] of batch.entries()) {
			const vector = vectors[index]!;
			if (vector.length !== provider.model.dimensions) throw new Error("embedding provider returned an invalid vector");
			await store.query("INSERT INTO brain_chunk_embeddings (chunk_id, tenant_id, brain_id, model_fingerprint, dimensions, embedding) VALUES ($1, $2, $3, $4, $5, $6::vector) ON CONFLICT (tenant_id, brain_id, chunk_id, model_fingerprint) DO UPDATE SET dimensions = EXCLUDED.dimensions, embedding = EXCLUDED.embedding, created_at = now()", [row.id, scope.tenantId, scope.brainId, modelIdentity, provider.model.dimensions, vectorLiteral(vector)]);
			// Keep the legacy columns populated for older callers and health reports;
			// model-aware reads use brain_chunk_embeddings below.
			await store.query("UPDATE brain_chunks SET embedding = $1::vector, embedding_model = $2 WHERE id = $3", [vectorLiteral(vector), modelIdentity, row.id]);
			embedded += 1;
		}
	}
	const dimension = provider.model.dimensions;
	const model = modelIdentity.replaceAll("'", "''");
	await store.exec(`CREATE INDEX IF NOT EXISTS ${indexName(modelIdentity, dimension)} ON brain_chunk_embeddings USING hnsw ((embedding::vector(${dimension})) vector_cosine_ops) WHERE model_fingerprint = '${model}'`);
	const coverageModule = await import([".", "analytics"].join(String.fromCharCode(47)));
	await coverageModule.refreshEmbeddingCoverage(store, { ...scope, modelFingerprint: modelIdentity });
	return { embedded, model: modelIdentity, dimensions: dimension };
}

export async function semanticSearch(store: Store, provider: Provider, query: string, limit = 20, scope: EmbeddingScope = { tenantId: "local", brainId: "local" }): Promise<Array<{ id: string; document_id: string; path: string; text: string; distance: number }>> {
	if (!scope.tenantId.trim() || !scope.brainId.trim()) throw new Error("invalid embedding scope");
	const [vector] = await provider.embed([query]);
	if (!vector || vector.length !== provider.model.dimensions) throw new Error("embedding provider returned an invalid vector");
	return store.query(
		"SELECT c.id, c.document_id, d.path, c.text, e.embedding <=> $1::vector AS distance FROM brain_chunk_embeddings e JOIN brain_chunks c ON c.id = e.chunk_id JOIN brain_documents d ON d.id = c.document_id WHERE d.tenant_id = $4 AND d.brain_id = $5 AND e.tenant_id = $4 AND e.brain_id = $5 AND d.deleted_at IS NULL AND ($6::jsonb IS NULL OR d.access_labels <@ $6::jsonb) AND e.model_fingerprint = $2 ORDER BY e.embedding <=> $1::vector, d.path LIMIT $3",
		[vectorLiteral(vector), provider.model.fingerprint ?? provider.model.id, limit, scope.tenantId, scope.brainId, scope.allowedAccessLabels === undefined ? null : JSON.stringify([...new Set(scope.allowedAccessLabels)].sort())],
	);
}
