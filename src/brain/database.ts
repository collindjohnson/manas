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

/** Applies only known, ordered migrations inside one transaction. */
function schemaVersion(database: Database): number | undefined {
	if (!tableExists(database, "schema_meta")) return undefined;
	const value = (
		database.prepare(SELECT_SCHEMA_VERSION).get() as { value?: string } | null
	)?.value;
	if (value === undefined) return undefined;
	const version = Number(value);
	if (!Number.isInteger(version) || version < 1)
		throw new Error("invalid brain schema version");
	return version;
}

function columnNames(database: Database, table: string): string[] {
	return (
		database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
			name: string;
		}>
	).map((column) => column.name);
}

function assertSupportedVersion(
	version: number | undefined,
): asserts version is 9 | undefined {
	if (version !== undefined && version > BRAIN_SCHEMA_VERSION)
		throw new Error(`unsupported newer brain schema version: ${version}`);
	if (version !== undefined && version < BRAIN_SCHEMA_VERSION)
		throw new Error(
			`brain schema v${version} requires migrate-identifiers before it can be opened`,
		);
}

export function readBrainSchemaVersion(path: string): number | undefined {
	const database = new Database(path, { readonly: true, strict: true });
	try {
		return schemaVersion(database);
	} finally {
		database.close();
	}
}

export function openIdentifierMigrationDatabase(path: string): Database {
	const database = new Database(path, { strict: true });
	try {
		database.exec("PRAGMA foreign_keys = ON");
		const version = schemaVersion(database);
		if (version !== BRAIN_SCHEMA_VERSION - 1)
			throw new Error(
				`migrate-identifiers requires SQLite brain schema v8; found ${version ?? "unknown"}`,
			);
		const columns = columnNames(database, "documents");
		if (!columns.includes("nessie_id") || columns.includes("manas_id"))
			throw new Error(
				"migrate-identifiers found an unexpected documents identifier schema",
			);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

export interface IdentifierHashUpdate {
	manasId: string;
	frontmatterHash: string;
}

export function migrateIdentifierColumn(
	database: Database,
	updates: IdentifierHashUpdate[],
): void {
	const migrate = database.transaction(() => {
		database.exec("ALTER TABLE documents RENAME COLUMN nessie_id TO manas_id");
		const update = database.prepare(
			"UPDATE documents SET frontmatter_hash = ? WHERE manas_id = ?",
		);
		for (const row of updates) update.run(row.frontmatterHash, row.manasId);
		database.prepare(UPSERT_SCHEMA_VERSION).run(String(BRAIN_SCHEMA_VERSION));
	});
	migrate.immediate();
}

export async function openBrainDatabase(path: string): Promise<Database> {
	const exists = await Bun.file(path).exists();
	if (exists) assertSupportedVersion(readBrainSchemaVersion(path));
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await chmod(dirname(path), 0o700);
	const database = new Database(path, { create: true, strict: true });
	try {
		database.exec(DATABASE_PRAGMAS);
		const version = schemaVersion(database);
		assertSupportedVersion(version);
		if (version === undefined) {
			database.exec(BRAIN_SCHEMA);
			database.prepare(UPSERT_SCHEMA_VERSION).run(String(BRAIN_SCHEMA_VERSION));
		} else database.exec(BRAIN_SCHEMA);
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
		if (schemaVersion(database) !== BRAIN_SCHEMA_VERSION)
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
