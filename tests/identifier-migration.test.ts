import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@manas/config";
import { migrateIdentifiers, IdentifierMigrationConflictError } from "@manas/identifier-migration";
import { BRAIN_SCHEMA, UPSERT_SCHEMA_VERSION } from "@manas-brain-schema";
import { sha256 } from "@manas/utils";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; config: Config; databasePath: string; document: string }> {
	const root = await mkdtemp(join(tmpdir(), "identifier-migration-"));
	roots.push(root);
	const archiveRoot = join(root, "archive");
	const stateRoot = join(root, "state");
	const databasePath = join(stateRoot, "brain.sqlite");
	const document = join(archiveRoot, "codex", "one.md");
	await mkdir(join(archiveRoot, "codex"), { recursive: true });
	await mkdir(stateRoot, { recursive: true });
	await Bun.write(document, `---\nnessie_id: "one"\ntitle: "One"\nprovider: "codex"\n---\n\nuser: preserved body\n`);
	const database = new Database(databasePath);
	database.exec(BRAIN_SCHEMA);
	database.prepare(UPSERT_SCHEMA_VERSION).run("9");
	database.prepare("INSERT INTO documents (manas_id, relative_path, provider, title, frontmatter_hash, body_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("one", "codex/one.md", "codex", "One", "legacy-frontmatter-hash", "body-hash", "now");
	database.prepare("INSERT INTO chunks (id, document_id, ordinal, start_offset, end_offset, text, text_hash, contextual_prefix, size_estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("chunk-one", "one", 0, 0, 20, "preserved body", "chunk-hash", "", 13);
	database.prepare("INSERT INTO local_chunk_embeddings (chunk_id, model_fingerprint, dimensions, embedding, created_at) VALUES (?, ?, ?, ?, ?)").run("chunk-one", "model", 2, new Uint8Array([0, 0, 128, 63, 0, 0, 0, 63]), "now");
	database.exec("ALTER TABLE documents RENAME COLUMN manas_id TO nessie_id");
	database.prepare("UPDATE schema_meta SET value = \"8\" WHERE key = \"schema_version\"").run();
	database.close();
	const config: Config = {
		archiveRoot,
		stateRoot,
		launchAgentPath: join(root, "agent.plist"),
		brain: {
			databasePath,
			zeroEntropyBaseUrl: "http://127.0.0.1:1/v1",
			zeroEntropyCollection: "migration-test",
			zeroEntropyBatchSize: 32,
			chunkTargetChars: 100,
			chunkMaxChars: 200,
			retrievalLimit: 10,
			synthesisEvidenceLimit: 5,
			requestTimeoutMs: 100,
			codexTimeoutMs: 100,
			synthesisCommand: "codex",
			keychainService: "test",
			keychainAccount: "test",
		},
	};
	return { root, config, databasePath, document };
}

describe("identifier migration", () => {
	test("previews without mutating archive or SQLite", async () => {
		const { config, databasePath, document } = await fixture();
		const beforeFile = await readFile(document, "utf8");
		const result = await migrateIdentifiers(config);
		expect(result).toMatchObject({ scanned: 1, migrated: 1, skipped: 0, conflicts: [], databaseVersion: 8, documentCount: 1, chunkCount: 1 });
		expect(await readFile(document, "utf8")).toBe(beforeFile);
		const database = new Database(databasePath, { readonly: true });
		expect(database.prepare("SELECT value FROM schema_meta WHERE key = \"schema_version\"").get()).toEqual({ value: "8" });
		database.close();
	});

	test("renames only the frontmatter key and preserves IDs, chunks, and vectors", async () => {
		const { config, databasePath, document } = await fixture();
		const result = await migrateIdentifiers(config, true);
		expect(result).toMatchObject({ migrated: 1, skipped: 0, databaseVersion: 9, documentCount: 1, chunkCount: 1 });
		expect(result.backupPath).toBeString();
		const content = await readFile(document, "utf8");
		expect(content).toContain('manas_id: "one"');
		expect(content).toContain("user: preserved body");
		expect(content).not.toContain("nessie_id");
		expect((await stat(document)).mode & 0o777).toBe(0o600);
		const database = new Database(databasePath, { readonly: true });
		expect(database.prepare("SELECT manas_id, frontmatter_hash FROM documents").get()).toEqual({ manas_id: "one", frontmatter_hash: sha256(content.slice(0, content.indexOf("\n---") + 4)) });
		expect(database.prepare("SELECT id FROM chunks").get()).toEqual({ id: "chunk-one" });
		expect(database.prepare("SELECT embedding FROM local_chunk_embeddings").get()).toEqual({ embedding: new Uint8Array([0, 0, 128, 63, 0, 0, 0, 63]) });
		expect(database.prepare("SELECT value FROM schema_meta WHERE key = \"schema_version\"").get()).toEqual({ value: "9" });
		expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		database.close();
		await access(join(result.backupPath!, "manifest.json"));
		await access(join(result.backupPath!, "brain.sqlite.snapshot"));
	});

	test("rejects conflicting mixed IDs before writing", async () => {
		const { config, document } = await fixture();
		await Bun.write(document, "---\nnessie_id: old\nmanas_id: new\n---\n\nbody\n");
		await expect(migrateIdentifiers(config, true)).rejects.toBeInstanceOf(IdentifierMigrationConflictError);
		expect(await readFile(document, "utf8")).toContain("nessie_id: old");
	});

	test("restores already-written files when a later write fails", async () => {
		const { config, document } = await fixture();
		const second = join(config.archiveRoot, "codex", "two.md");
		await Bun.write(second, "---\nnessie_id: two\n---\n\nsecond\n");
		const injectedWriteFile = ((path: string, data: unknown, options?: unknown) => {
			if (path.includes(".migrate-")) {
				if (path.endsWith("-1")) return Promise.reject(new Error("injected write failure"));
			}
			return writeFile(path, data as never, options as never);
		}) as typeof writeFile;
		await expect(migrateIdentifiers(config, true, { writeFile: injectedWriteFile })).rejects.toThrow("injected write failure");
		expect(await readFile(document, "utf8")).toContain("nessie_id: \"one\"");
		expect(await readFile(second, "utf8")).toContain("nessie_id: two");
	});
});
