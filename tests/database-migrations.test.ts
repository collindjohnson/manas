import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPgliteBrainStore } from "../src/brain/store";
import { BRAIN_STORE_MIGRATIONS, BRAIN_STORE_SCHEMA_VERSION } from "../src/brain/store";
import { runDatabaseMigrations, sqlMigration } from "../src/brain/migrations";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ordered database migrations", () => {
	test("exposes the same latest version as the ordered migration list", () => {
		expect(BRAIN_STORE_SCHEMA_VERSION).toBe(BRAIN_STORE_MIGRATIONS[BRAIN_STORE_MIGRATIONS.length - 1]!.version);
	});

	test("records a checksum and is idempotent after reopening persistent PGLite", async () => {
		const directory = await mkdtemp(join(tmpdir(), "brain-migrations-"));
		directories.push(directory);
		const first = await openPgliteBrainStore(directory);
		expect(await first.query("SELECT version, name, checksum FROM brain_migration_history")).toContainEqual(expect.objectContaining({ version: 12, name: "initial-shared-brain-schema" }));
		expect(await first.query("SELECT version, name, checksum FROM brain_migration_history")).toContainEqual(expect.objectContaining({ version: 13, name: "incremental-projection-runs" }));
		expect(await first.query("SELECT version, name, checksum FROM brain_migration_history")).toContainEqual(expect.objectContaining({ version: 17, name: "graph-facts-cache-and-coverage" }));
		expect(await first.query("SELECT version, name, checksum FROM brain_migration_history")).toContainEqual(expect.objectContaining({ version: 21, name: "model-index-tenant-brain-scope" }));
		expect(await first.query("SELECT version, name, checksum FROM brain_migration_history")).toContainEqual(expect.objectContaining({ version: 22, name: "durable-skill-feedback" }));
		expect(await first.query("SELECT version, name, checksum FROM brain_migration_history")).toContainEqual(expect.objectContaining({ version: 23, name: "durable-admin-action-receipts" }));
		expect(await first.query("SELECT version, name, checksum FROM brain_migration_history")).toContainEqual(expect.objectContaining({ version: 24, name: "single-owner-scheduler-leases" }));
		const firstHistory = await first.query("SELECT version, checksum FROM brain_migration_history");
		await first.close();
		const reopened = await openPgliteBrainStore(directory);
		expect(await reopened.query("SELECT version, checksum FROM brain_migration_history")).toEqual(firstHistory);
		await reopened.close();
	});

	test("refuses an altered historical migration checksum", async () => {
		const directory = await mkdtemp(join(tmpdir(), "brain-migration-checksum-"));
		directories.push(directory);
		const store = await openPgliteBrainStore(directory);
		await store.exec("UPDATE brain_migration_history SET checksum = 'altered' WHERE version = 12");
		await store.close();
		await expect(openPgliteBrainStore(directory)).rejects.toThrow("checksum mismatch");
	});

	test("upgrades a supported older schema fixture before reopening", async () => {
		const directory = await mkdtemp(join(tmpdir(), "brain-migration-older-"));
		directories.push(directory);
		const store = await openPgliteBrainStore(directory);
		await store.exec("DELETE FROM brain_migration_history WHERE version > 14; DROP TABLE brain_chunk_embeddings; UPDATE brain_schema_meta SET value = '14' WHERE key = 'schema_version'");
		await store.close();
		const reopened = await openPgliteBrainStore(directory);
		expect((await reopened.query<{ version: number }>("SELECT version FROM brain_migration_history ORDER BY version DESC LIMIT 1"))[0]?.version).toBe(24);
		expect(await reopened.query("SELECT 1 FROM brain_chunk_embeddings LIMIT 1")).toEqual([]);
		await reopened.close();
	});

	test("rolls back a failed migration transaction without recording partial schema", async () => {
		const store = await openPgliteBrainStore();
		try {
			const broken = sqlMigration(25, "broken-test-migration", "CREATE TABLE brain_failed_migration_fixture (id text PRIMARY KEY)", async () => { throw new Error("mid migration failure"); });
			await expect(runDatabaseMigrations(store, [...BRAIN_STORE_MIGRATIONS, broken])).rejects.toThrow("mid migration failure");
			expect(await store.query("SELECT version FROM brain_migration_history WHERE version = 25")).toEqual([]);
			await expect(store.query("SELECT 1 FROM brain_failed_migration_fixture")).rejects.toThrow();
		} finally { await store.close(); }
	});
});
