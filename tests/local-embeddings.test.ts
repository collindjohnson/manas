import { describe, expect, test } from "bun:test";

const storeModule = ["..", "src", "brain", "store"].join(String.fromCharCode(47));
const embeddingsModule = ["..", "src", "brain", "local-embeddings"].join(String.fromCharCode(47));
const { openPgliteBrainStore } = await import(storeModule);
const { indexLocalEmbeddings, semanticSearch } = await import(embeddingsModule);

const provider = {
	model: { id: "local-test", dimensions: 2 },
	embed: async (texts: string[]) => texts.map((text) => text.includes("apple") ? [1, 0] : [0, 1]),
};

describe("local embeddings", () => {
	test("stores local vectors and retrieves semantic neighbors", async () => {
		const store = await openPgliteBrainStore();
		try {
			await store.exec("INSERT INTO brain_documents (id, path, content_hash, revision) VALUES ('doc-a', 'notes/a.md', 'a', 'a'), ('doc-b', 'notes/b.md', 'b', 'b')");
			await store.exec("INSERT INTO brain_chunks (id, document_id, ordinal, text, search_vector) VALUES ('chunk-a', 'doc-a', 0, 'apple orchard', to_tsvector('simple', 'apple orchard')), ('chunk-b', 'doc-b', 0, 'ocean water', to_tsvector('simple', 'ocean water'))");
			expect(await indexLocalEmbeddings(store, provider)).toMatchObject({ embedded: 2, model: "local-test", dimensions: 2 });
			expect((await semanticSearch(store, provider, "apple"))[0]).toMatchObject({ id: "chunk-a" });
		} finally { await store.close(); }
	});

	test("uses a model fingerprint to separate vector compatibility domains", async () => {
		const store = await openPgliteBrainStore();
		try {
			await store.exec("INSERT INTO brain_documents (id, path, content_hash, revision) VALUES ('fingerprint-doc', 'notes/fingerprint.md', 'h', 'r')");
			await store.exec("INSERT INTO brain_chunks (id, document_id, ordinal, text, search_vector) VALUES ('fingerprint-chunk', 'fingerprint-doc', 0, 'fingerprint text', to_tsvector('simple', 'fingerprint text'))");
			const provider = { model: { id: "same-name", dimensions: 2, fingerprint: "fingerprint-a" }, embed: async () => [[1, 0]] };
			await indexLocalEmbeddings(store, provider);
			expect(await store.query("SELECT embedding_model FROM brain_chunks WHERE id = 'fingerprint-chunk'")).toEqual([{ embedding_model: "fingerprint-a" }]);
		} finally { await store.close(); }
	});
});
