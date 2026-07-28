import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modulePath = ["..", "src", "brain", "store"].join(String.fromCharCode(47));
const { openPgliteBrainStore } = await import(modulePath);

describe("PGLite brain store", () => {
	test("uses PostgreSQL full text search and rolls back transactions", async () => {
		const store = await openPgliteBrainStore();
		try {
			await store.exec("INSERT INTO brain_documents (id, path, content_hash, revision) VALUES ('00000000-0000-0000-0000-000000000001', 'notes/test.md', 'hash', 'revision')");
			await store.exec("INSERT INTO brain_chunks (id, document_id, ordinal, text, search_vector) VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 0, 'hybrid retrieval with postgres', to_tsvector('simple', 'hybrid retrieval with postgres'))");
			const results = await store.query("SELECT text FROM brain_chunks WHERE search_vector @@ plainto_tsquery('simple', $1)", ["hybrid postgres"]);
			expect(results).toEqual([{ text: "hybrid retrieval with postgres" }]);
			await expect(store.transaction(async (transaction: any) => {
				await transaction.exec("INSERT INTO brain_documents (id, path, content_hash, revision) VALUES ('00000000-0000-0000-0000-000000000003', 'notes/rollback.md', 'hash', 'revision')");
				throw new Error("rollback");
			})).rejects.toThrow("rollback");
			expect(await store.query("SELECT id FROM brain_documents WHERE path = $1", ["notes/rollback.md"])).toEqual([]);
		} finally {
			await store.close();
		}
	});

	test("allows the same page path in distinct brains", async () => {
		const store = await openPgliteBrainStore();
		try {
			await store.exec("INSERT INTO brain_documents (id, path, content_hash, revision, brain_id) VALUES ('brain-a-page', 'notes/shared.md', 'a', 'a', 'brain-a'), ('brain-b-page', 'notes/shared.md', 'b', 'b', 'brain-b')");
			expect(await store.query("SELECT id FROM brain_documents WHERE path = 'notes/shared.md' ORDER BY id")).toEqual([{ id: "brain-a-page" }, { id: "brain-b-page" }]);
		} finally { await store.close(); }
	});

	test("refuses a PGLite store created by a newer schema", async () => {
		const directory = await mkdtemp(join(tmpdir(), "brain-newer-schema-"));
		const store = await openPgliteBrainStore(directory);
		await store.exec("UPDATE brain_schema_meta SET value = '999' WHERE key = 'schema_version'");
		await store.close();
		await expect(openPgliteBrainStore(directory)).rejects.toThrow("newer than supported");
		await rm(directory, { recursive: true, force: true });
	});
});
