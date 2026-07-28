import { describe, expect, test } from "bun:test";

const storeModule = ["..", "src", "brain", "store"].join(String.fromCharCode(47));
const stateModule = ["..", "src", "brain", "embedding-state"].join(String.fromCharCode(47));
const { openPgliteBrainStore } = await import(storeModule);
const { activeEmbeddingModel, buildAndActivateEmbeddingModel, embeddingFingerprint, rollbackEmbeddingModel, setActiveEmbeddingModel } = await import(stateModule);

describe("embedding model state", () => {
	test("pins a model and requests resumable re-embedding only on model changes", async () => {
		const store = await openPgliteBrainStore();
		try {
			expect(await activeEmbeddingModel(store)).toBeUndefined();
			expect(await setActiveEmbeddingModel(store, { id: "local-model", dimensions: 3 })).toEqual({ changed: true, reembeddingRequired: true });
			expect(await activeEmbeddingModel(store)).toMatchObject({ id: "local-model", dimensions: 3 });
			expect(await setActiveEmbeddingModel(store, { id: "local-model", dimensions: 3 })).toEqual({ changed: false, reembeddingRequired: false });
			expect(await setActiveEmbeddingModel(store, { id: "next-model", dimensions: 4 })).toEqual({ changed: true, reembeddingRequired: true });
		} finally { await store.close(); }
	});

	test("changes identity when privacy or template semantics change", () => {
		expect(embeddingFingerprint({ id: "model", dimensions: 3, privacy: "local" })).not.toBe(embeddingFingerprint({ id: "model", dimensions: 3, privacy: "hosted" }));
		expect(embeddingFingerprint({ id: "model", dimensions: 3, templateVersion: "1" })).not.toBe(embeddingFingerprint({ id: "model", dimensions: 3, templateVersion: "2" }));
	});

	test("keeps prior model vectors available while a replacement is selected", async () => {
		const store = await openPgliteBrainStore();
		try {
			await store.query("INSERT INTO brain_documents (id, path, content_hash, revision, tenant_id, brain_id, repository_id) VALUES ('embedding-doc', 'embedding.md', 'hash', 'rev', 'local', 'local', 'local')");
			await store.query("INSERT INTO brain_chunks (id, document_id, ordinal, text, search_vector, embedding_model) VALUES ('embedding-chunk', 'embedding-doc', 0, 'text', to_tsvector('simple', 'text'), 'old-model')");
			await setActiveEmbeddingModel(store, { id: "old-model", dimensions: 2 });
			await setActiveEmbeddingModel(store, { id: "new-model", dimensions: 3 });
			expect(await store.query("SELECT embedding_model FROM brain_chunks WHERE id = 'embedding-chunk'")).toEqual([{ embedding_model: "old-model" }]);
		} finally { await store.close(); }
	});

	test("builds a model-specific replacement and rolls back the active pointer", async () => {
		const store = await openPgliteBrainStore();
		try {
			await store.exec("INSERT INTO brain_documents (id, path, content_hash, revision, tenant_id, brain_id, repository_id) VALUES ('replacement-doc', 'replacement.md', 'hash', 'rev', 'local', 'local', 'local')");
			await store.exec("INSERT INTO brain_chunks (id, document_id, ordinal, text, search_vector) VALUES ('replacement-chunk', 'replacement-doc', 0, 'replacement text', to_tsvector('simple', 'replacement text'))");
			const oldProvider = { model: { id: "old-provider", dimensions: 2 }, embed: async () => [[1, 0]] };
			const newProvider = { model: { id: "new-provider", dimensions: 3 }, embed: async () => [[1, 0, 0]] };
			await buildAndActivateEmbeddingModel(store, oldProvider, { now: new Date("2026-01-01T00:00:00Z") });
			const receipt = await buildAndActivateEmbeddingModel(store, newProvider, { now: new Date("2026-01-02T00:00:00Z"), rollbackWindowMs: 60_000 });
			expect(receipt).toMatchObject({ previous: { id: "old-provider" }, active: { id: "new-provider" }, totalChunks: 1, coveredChunks: 1 });
			expect(await store.query("SELECT model_fingerprint FROM brain_chunk_embeddings WHERE chunk_id = 'replacement-chunk' ORDER BY model_fingerprint")).toHaveLength(2);
			expect((await rollbackEmbeddingModel(store, new Date("2026-01-02T00:00:30Z"))).id).toBe("old-provider");
			expect((await activeEmbeddingModel(store))?.id).toBe("old-provider");
		} finally { await store.close(); }
	});
});
