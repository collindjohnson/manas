import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
	BRAIN_SCHEMA,
	BRAIN_SCHEMA_VERSION,
	DATABASE_PRAGMAS,
	INTEGRITY_CHECK,
	SELECT_SCHEMA_VERSION,
	UPSERT_SCHEMA_VERSION,
} from "./schema";

function tableExists(database: Database, name: string): boolean {
	return Boolean(
		database
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(name),
	);
}

function hasColumn(
	database: Database,
	columnsSql:
		| "PRAGMA table_info(documents)"
		| "PRAGMA table_info(index_runs)"
		| "PRAGMA table_info(remote_chunk_checkpoints)"
		| "PRAGMA table_info(remote_tombstones)",
	column: string,
): boolean {
	return (database.prepare(columnsSql).all() as Array<{ name: string }>).some(
		(item) => item.name === column,
	);
}

/** Applies only known, ordered migrations inside one transaction. */
function migrate(database: Database, version: number | undefined): void {
	if (version === undefined) {
		database.exec(BRAIN_SCHEMA);
		database.prepare(UPSERT_SCHEMA_VERSION).run(String(BRAIN_SCHEMA_VERSION));
		return;
	}
	if (version > BRAIN_SCHEMA_VERSION)
		throw new Error(`unsupported newer brain schema version: ${version}`);
	database.transaction(() => {
		let current = version;
		if (current < 6) {
			// v5 predated source-path metadata and operational run fields.
			if (!hasColumn(database, "PRAGMA table_info(documents)", "source_path"))
				database.exec("ALTER TABLE documents ADD COLUMN source_path TEXT");
			const runColumns = "PRAGMA table_info(index_runs)" as const;
			if (!hasColumn(database, runColumns, "local_status"))
				database.exec("ALTER TABLE index_runs ADD COLUMN local_status TEXT");
			if (!hasColumn(database, runColumns, "remote_status"))
				database.exec("ALTER TABLE index_runs ADD COLUMN remote_status TEXT");
			if (!hasColumn(database, runColumns, "collection_name"))
				database.exec("ALTER TABLE index_runs ADD COLUMN collection_name TEXT");
			if (!hasColumn(database, runColumns, "documents_scanned"))
				database.exec(
					"ALTER TABLE index_runs ADD COLUMN documents_scanned INTEGER NOT NULL DEFAULT 0",
				);
			if (!hasColumn(database, runColumns, "remote_pending"))
				database.exec(
					"ALTER TABLE index_runs ADD COLUMN remote_pending INTEGER NOT NULL DEFAULT 0",
				);
			current = 6;
		}
		if (current < 7) {
			// Some v5 databases predate checkpoint/tombstone tables entirely. Create
			// missing tables before inspecting their columns; CREATE IF NOT EXISTS does
			// not alter or discard compatible existing data.
			if (
				!tableExists(database, "remote_chunk_checkpoints") ||
				!tableExists(database, "remote_tombstones")
			)
				database.exec(BRAIN_SCHEMA);
			if (
				!hasColumn(
					database,
					"PRAGMA table_info(remote_chunk_checkpoints)",
					"next_retry_at",
				)
			)
				database.exec(
					"ALTER TABLE remote_chunk_checkpoints ADD COLUMN next_retry_at TEXT",
				);
			if (
				!hasColumn(
					database,
					"PRAGMA table_info(remote_tombstones)",
					"next_retry_at",
				)
			)
				database.exec(
					"ALTER TABLE remote_tombstones ADD COLUMN next_retry_at TEXT",
				);
			current = 7;
		}
		database.exec(BRAIN_SCHEMA);
		// Local vectors are intentionally obsolete under managed semantic indexing.
		database.exec(
			"DROP TABLE IF EXISTS embeddings; DROP TABLE IF EXISTS embedding_failures;",
		);
		database.prepare(UPSERT_SCHEMA_VERSION).run(String(current));
	})();
}

function inspectExistingVersion(path: string): number | undefined {
	const database = new Database(path, { readonly: true, strict: true });
	try {
		if (!tableExists(database, "schema_meta")) return undefined;
		const version = Number(
			(
				database.prepare(SELECT_SCHEMA_VERSION).get() as {
					value?: string;
				} | null
			)?.value,
		);
		if (!Number.isInteger(version) || version < 1)
			throw new Error("invalid brain schema version");
		if (version > BRAIN_SCHEMA_VERSION)
			throw new Error(`unsupported newer brain schema version: ${version}`);
		return version;
	} finally {
		database.close();
	}
}

export async function openBrainDatabase(path: string): Promise<Database> {
	// A newer existing database is inspected read-only before any directory
	// creation, permission adjustment, WAL pragma, or DDL can touch it.
	if (await Bun.file(path).exists()) inspectExistingVersion(path);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await chmod(dirname(path), 0o700);
	const database = new Database(path, { create: true, strict: true });
	try {
		database.exec(DATABASE_PRAGMAS);
		// Do not run CREATE/ALTER statements until a pre-existing version is known
		// to be supported. This preserves newer databases byte-for-byte.
		const version = tableExists(database, "schema_meta")
			? Number(
					(
						database.prepare(SELECT_SCHEMA_VERSION).get() as {
							value?: string;
						} | null
					)?.value,
				)
			: undefined;
		if (version !== undefined && (!Number.isInteger(version) || version < 1))
			throw new Error("invalid brain schema version");
		migrate(database, version);
		await chmod(path, 0o600);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

export function assertBrainIntegrity(database: Database): void {
	const result = database.prepare(INTEGRITY_CHECK).get() as {
		integrity_check?: string;
	} | null;
	if (result?.integrity_check !== "ok")
		throw new Error(
			"brain database integrity check failed; run index --rebuild",
		);
}

// Opens an existing supported database without creating, migrating, or changing it.
export function inspectBrainDatabase(path: string): Database {
	const database = new Database(path, { readonly: true, strict: true });
	try {
		const version = tableExists(database, "schema_meta")
			? Number(
					(
						database.prepare(SELECT_SCHEMA_VERSION).get() as {
							value?: string;
						} | null
					)?.value,
				)
			: undefined;
		if (
			version === undefined ||
			!Number.isInteger(version) ||
			version < 1 ||
			version > BRAIN_SCHEMA_VERSION
		)
			throw new Error("brain database is not a supported schema");
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

export function inTransaction<T>(database: Database, action: () => T): T {
	return database.transaction(action)();
}
