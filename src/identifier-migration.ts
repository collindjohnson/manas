import { Database } from "bun:sqlite";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { Config } from "@manas/config";
import { parseFrontmatter } from "@manas/archive";
import { migrateIdentifierColumn, openIdentifierMigrationDatabase, readBrainSchemaVersion } from "@manas-brain-database";
import { BRAIN_SCHEMA_VERSION } from "@manas-brain-schema";
import { sha256 } from "@manas/utils";
import { withIndexLock } from "@manas/state";

export interface IdentifierMigrationFile {
	path: string;
	relativePath: string;
	action: "migrate" | "skip";
	legacyId?: string;
	manasId: string;
	beforeHash: string;
	afterHash: string;
}

export interface IdentifierMigrationResult {
	scanned: number;
	migrated: number;
	skipped: number;
	conflicts: string[];
	databaseVersion: number | undefined;
	backupPath?: string;
	files: IdentifierMigrationFile[];
	documentCount: number;
	chunkCount: number;
}

export class IdentifierMigrationConflictError extends Error {
	readonly result: IdentifierMigrationResult;
	constructor(result: IdentifierMigrationResult) {
		super("identifier migration found conflicting archive or database state");
		this.name = "IdentifierMigrationConflictError";
		this.result = result;
	}
}

interface PlannedFile extends IdentifierMigrationFile {
	before: string;
	after: string;
}

interface DatabaseState {
	version: number | undefined;
	documents: number;
	chunks: number;
	foreignKeys: unknown[];
	integrity: string;
}

export interface IdentifierMigrationIO {
	writeFile?: typeof writeFile;
	rename?: typeof rename;
}

const excludedNames = new Set(["INDEX.md", "SYNC_REPORT.md", "EXPORT_REPORT.md"]);

async function markdownFiles(root: string): Promise<string[]> {
	const paths: string[] = [];
	async function visit(directory: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && entry.name.endsWith(".md") && !excludedNames.has(entry.name)) paths.push(path);
		}
	}
	await visit(root);
	return paths.sort();
}

function frontmatterHeader(content: string): { header: string; end: number } | undefined {
	if (!content.startsWith("---\n")) return undefined;
	const end = content.indexOf("\n---", 4);
	if (end < 0) return undefined;
	return { header: content.slice(0, end + 4), end };
}

function scalarId(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			return typeof parsed === "string" ? parsed : "";
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
	return trimmed;
}

function frontmatterIds(header: string, key: string): string[] {
	return header
		.split("\n")
		.filter((line) => line.startsWith(`${key}:`))
		.map((line) => scalarId(line.slice(key.length + 1)))
		.filter(Boolean);
}

function canonicalize(content: string, header: string, end: number, hasCanonical: boolean): string {
	const rewritten = header.split("\n").flatMap((line) => {
		if (!line.startsWith("nessie_id:")) return [line];
		if (hasCanonical) return [];
		return [`manas_id:${line.slice("nessie_id:".length)}`];
	});
	return rewritten.join("\n") + content.slice(end + 4);
}

async function planArchive(root: string): Promise<{ files: PlannedFile[]; conflicts: string[]; scanned: number }> {
	const files: PlannedFile[] = [];
	const conflicts: string[] = [];
	const seen = new Map<string, string>();
	for (const path of await markdownFiles(root)) {
		const content = await readFile(path, "utf8");
		const parsed = parseFrontmatter(content);
		const bounds = frontmatterHeader(content);
		const relativePath = relative(root, path).split(sep).join(String.fromCharCode(47));
		if (!parsed || !bounds) {
			conflicts.push(`${relativePath}: missing or malformed frontmatter`);
			continue;
		}
		const legacyIds = [...new Set(frontmatterIds(bounds.header, "nessie_id"))];
		const manasIds = [...new Set(frontmatterIds(bounds.header, "manas_id"))];
		if (legacyIds.length > 1 || manasIds.length > 1) {
			conflicts.push(`${relativePath}: duplicate identifier values`);
			continue;
		}
		const legacyId = legacyIds[0];
		const manasId = manasIds[0];
		if (legacyId && manasId && legacyId !== manasId) {
			conflicts.push(`${relativePath}: conflicting identifier values`);
			continue;
		}
		const effectiveId = manasId ?? legacyId;
		if (!effectiveId) {
			conflicts.push(`${relativePath}: missing identifier`);
			continue;
		}
		const priorPath = seen.get(effectiveId);
		if (priorPath) {
			conflicts.push(`${relativePath}: duplicate identifier ${effectiveId} also appears at ${priorPath}`);
			continue;
		}
		seen.set(effectiveId, relativePath);
		const action = legacyId ? "migrate" : "skip";
		const after = action === "migrate" ? canonicalize(content, bounds.header, bounds.end, Boolean(manasId)) : content;
		files.push({
			path,
			relativePath,
			action,
			...(legacyId ? { legacyId } : {}),
			manasId: effectiveId,
			beforeHash: sha256(content),
			afterHash: sha256(after),
			before: content,
			after,
		});
	}
	return { files, conflicts, scanned: files.length + conflicts.length };
}

function inspectDatabase(path: string): DatabaseState {
	const database = new Database(path, { readonly: true, strict: true });
	try {
		const version = readBrainSchemaVersion(path);
		if (version !== undefined && version > BRAIN_SCHEMA_VERSION)
			throw new Error(`unsupported newer brain schema version: ${version}`);
		const documents = Number((database.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number }).count);
		const chunks = Number((database.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number }).count);
		const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
		const integrity = (database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }).integrity_check ?? "failed";
		return { version, documents, chunks, foreignKeys, integrity };
	} finally {
		database.close();
	}
}

function resultFor(
	plan: Awaited<ReturnType<typeof planArchive>>,
	database: DatabaseState,
	backupPath?: string,
): IdentifierMigrationResult {
	return {
		scanned: plan.scanned,
		migrated: plan.files.filter((file) => file.action === "migrate").length,
		skipped: plan.files.filter((file) => file.action === "skip").length,
		conflicts: plan.conflicts,
		databaseVersion: database.version,
		...(backupPath ? { backupPath } : {}),
		files: plan.files.map(({ before, after, ...file }) => file),
		documentCount: database.documents,
		chunkCount: database.chunks,
	};
}

async function restoreFiles(backupPath: string, files: PlannedFile[], io: Required<IdentifierMigrationIO>): Promise<void> {
	for (const file of files.filter((entry) => entry.action === "migrate")) {
		const backup = await readFile(join(backupPath, "archive", file.relativePath), "utf8");
		const temporary = `${file.path}.restore-${process.pid}`;
		await io.writeFile(temporary, backup, { encoding: "utf8", mode: 0o600 });
		await io.rename(temporary, file.path);
	}
}

async function execute(
	config: Config,
	plan: Awaited<ReturnType<typeof planArchive>>,
	databaseState: DatabaseState,
	io: Required<IdentifierMigrationIO>,
): Promise<IdentifierMigrationResult> {
	if (plan.conflicts.length) throw new IdentifierMigrationConflictError(resultFor(plan, databaseState));
	if (databaseState.version !== BRAIN_SCHEMA_VERSION - 1)
		throw new Error(`migrate-identifiers requires SQLite brain schema v8; found ${databaseState.version ?? "unknown"}`);
	if (databaseState.foreignKeys.length || databaseState.integrity !== "ok")
		throw new Error("migrate-identifiers requires a valid SQLite database before mutation");
	const timestamp = new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replaceAll(".", "");
	const backupPath = join(config.stateRoot, "identifier-migrations", `${timestamp}-${process.pid}`);
	await mkdir(join(backupPath, "archive"), { recursive: true, mode: 0o700 });
	const database = openIdentifierMigrationDatabase(config.brain!.databasePath);
	try {
		const snapshot = database.transaction(() => database.serialize()).immediate();
		await io.writeFile(join(backupPath, "brain.sqlite.snapshot"), snapshot, { mode: 0o600 });
		for (const file of plan.files.filter((entry) => entry.action === "migrate")) {
			const destination = join(backupPath, "archive", file.relativePath);
			await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
			await io.writeFile(destination, file.before, { mode: 0o600 });
		}
		await io.writeFile(
			join(backupPath, "manifest.json"),
			JSON.stringify(
				{
					version: 1,
					createdAt: new Date().toISOString(),
					archiveRoot: config.archiveRoot,
					databasePath: config.brain!.databasePath,
					files: plan.files.map(({ before, after, ...file }) => file),
				},
				null,
			) + "\n",
			{ mode: 0o600 },
		);
		try {
			for (const [index, file] of plan.files.filter((entry) => entry.action === "migrate").entries()) {
				const current = await readFile(file.path, "utf8");
				if (sha256(current) !== file.beforeHash) throw new Error(`archive changed during migration: ${file.relativePath}`);
				const temporary = `${file.path}.migrate-${process.pid}-${index}`;
				await io.writeFile(temporary, file.after, { encoding: "utf8", mode: 0o600 });
				await io.rename(temporary, file.path);
			}
			const updates = plan.files
				.filter((file) => file.action === "migrate")
				.map((file) => ({
					manasId: file.manasId,
					frontmatterHash: sha256(frontmatterHeader(file.after)!.header),
				}));
			migrateIdentifierColumn(database, updates);
			const migratedState = inspectDatabase(config.brain!.databasePath);
			if (
				migratedState.version !== BRAIN_SCHEMA_VERSION ||
				migratedState.documents !== databaseState.documents ||
				migratedState.chunks !== databaseState.chunks ||
				migratedState.foreignKeys.length ||
				migratedState.integrity !== "ok"
			)
				throw new Error("identifier migration verification failed");
			return resultFor(plan, migratedState, backupPath);
		} catch (error) {
			await restoreFiles(backupPath, plan.files, io);
			throw error;
		}
	} finally {
		database.close();
	}
}

export async function migrateIdentifiers(
	config: Config,
	mutate = false,
	dependencies: IdentifierMigrationIO = {},
): Promise<IdentifierMigrationResult> {
	if (!config.brain) throw new Error("brain configuration is unavailable");
	const run = async () => {
		const plan = await planArchive(config.archiveRoot);
		const databaseState = inspectDatabase(config.brain!.databasePath);
		if (!mutate) {
			if (plan.conflicts.length)
				throw new IdentifierMigrationConflictError(resultFor(plan, databaseState));
			return resultFor(plan, databaseState);
		}
		return execute(config, plan, databaseState, {
			writeFile: dependencies.writeFile ?? writeFile,
			rename: dependencies.rename ?? rename,
		});
	};
	return mutate ? withIndexLock(config.stateRoot, run) : run();
}
