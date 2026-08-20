import { homedir } from "node:os";
import * as verifyModule from "./report";
import * as archiveModule from "./archive";
import * as agentModule from "./launch-agent";
import { access, chmod, copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const execFile = promisify(execFileCallback);
const slash = String.fromCharCode(47);
export async function preflightChatHistorySyncMigration(configPath: string): Promise<Record<string, unknown>> {
	const home = homedir();
	const archiveRoot = resolve(home, "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents", "chat-history");
	const legacyPath = resolve(home, "Library", "LaunchAgents", "com.virdis.chat-history-sync.plist");
	const launchAgentPath = resolve(home, "Library", "LaunchAgents", "com.collindjohnson.manas.plist");
	const stateRoot = resolve(home, ".local", "state", "manas");
	try { await lstat(archiveRoot); } catch { throw new Error(`expected Obsidian chat-history vault is unavailable: ${archiveRoot}`); }
	await access(archiveRoot, 2);
	const verification = await verifyModule.verifyArchive(archiveRoot);
	if (!verification.ok) throw new Error(`existing archive verification failed: ${verification.errors.join("; ")}`);
	const target = resolve(configPath);
	try { await lstat(target); throw new Error(`refusing to overwrite existing configuration: ${target}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const config = { archiveRoot, stateRoot, launchAgentPath };
	const plist = agentModule.renderLaunchAgent(config, target);
	const errors = agentModule.validateLaunchAgent(plist);
	if (errors.length) throw new Error(errors.join("; "));
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	await writeFile(target, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
	await chmod(target, 0o600);
	await mkdir(dirname(launchAgentPath), { recursive: true });
	await writeFile(launchAgentPath, plist, { mode: 0o644 });
	const archive = await archiveModule.scanArchive(archiveRoot);
	let legacyAgentText = "";
	try { legacyAgentText = await readFile(legacyPath, "utf8"); } catch {}
	const legacyStateCandidates = [resolve(home, ".local", "state", "chat-history-sync"), resolve(home, ".chat-history-sync")];
	const legacyState: string[] = [];
	for (const path of legacyStateCandidates) try { await lstat(path); legacyState.push(path); } catch {}
	return { archiveRoot, stateRoot, configPath: target, launchAgentPath, archive: { documents: archive.documents.length, verification, reachable: true, writable: true }, legacyAgent: { path: legacyPath, exists: Boolean(legacyAgentText), referencesRemovedSource: legacyAgentText.includes("chat-history-sync") }, legacyState: { paths: legacyState, reused: false, reason: "Manas will scan sources and deduplicate against the verified archive" }, planned: { configWritten: true, plistWritten: true, activated: false, legacyAgentModified: false } };
}

type RepositoryLike = { root: string; initialize(): Promise<void> };

export type MigrationRolloutStage = "legacy" | "byte-preserving-import" | "manifest-commit" | "managed-sections" | "projection" | "retrieval-shadow" | "source-shadow" | "new-read-path" | "git-writes" | "hosted-access" | "autonomous-dry-run" | "managed-automation" | "full-automation";
export interface MigrationReconciliationEntry {
	sourcePath: string;
	targetPath: string;
	sourceHash: string;
	targetHash?: string;
	id?: string;
	status: "imported" | "already-present" | "collision" | "unresolved";
}
export interface MigrationReconciliationReport {
	sourceFiles: number;
	importedFiles: number;
	skippedFiles: number;
	collisions: number;
	unresolvedMoves: number;
	ignoredFiles: string[];
	stableIds: Array<{ sourcePath: string; id: string }>;
	contentHashes: Array<{ sourcePath: string; hash: string }>;
	sourceMappings: Array<{ sourcePath: string; targetPath: string; id?: string }>;
	entries: MigrationReconciliationEntry[];
}

const rolloutStages: MigrationRolloutStage[] = ["legacy", "byte-preserving-import", "manifest-commit", "managed-sections", "projection", "retrieval-shadow", "source-shadow", "new-read-path", "git-writes", "hosted-access", "autonomous-dry-run", "managed-automation", "full-automation"];

function hash(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function pageId(content: string): string {
	const line = content.split("\n").find((value) => value.startsWith("manas_id:"));
	if (!line) return randomUUID();
	const value = line.slice(line.indexOf(":") + 1).trim().replaceAll('"', "").replaceAll("'", "");
	return value || randomUUID();
}

function safeRelative(root: string, path: string): string {
	const value = relative(root, path).split(sep).join(slash);
	if (!value || value.startsWith("..") || value === ".git" || value.startsWith(`.git${slash}`) || value === ".brain" || value.startsWith(`.brain${slash}`)) throw new Error("invalid legacy archive path");
	return value;
}

async function git(root: string, args: string[]): Promise<string> {
	return (await execFile("git", ["-C", root, ...args])).stdout.trim();
}

export async function reconcileLegacyArchive(source: string, target: string): Promise<MigrationReconciliationReport> {
	const sourceRoot = resolve(source);
	const targetRoot = resolve(target);
	const files: string[] = [];
	const ignoredFiles: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const ignoredPath = relative(sourceRoot, path).split(sep).join(slash);
			if (entry.name === ".git" || entry.name === ".brain" || entry.name.startsWith(".")) { ignoredFiles.push(ignoredPath); continue; }
			if (entry.isSymbolicLink()) { ignoredFiles.push(ignoredPath); continue; }
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) files.push(path);
		}
	};
	await visit(sourceRoot);
	const entries: MigrationReconciliationEntry[] = [];
	for (const sourcePath of files.sort()) {
		const relativePath = safeRelative(sourceRoot, sourcePath);
		const targetPath = join(targetRoot, relativePath);
		const sourceBytes = await readFile(sourcePath);
		const sourceHash = hash(sourceBytes);
		let targetHash: string | undefined;
		try { targetHash = hash(await readFile(targetPath)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		entries.push({ sourcePath: relativePath, targetPath: relativePath, sourceHash, ...(targetHash ? { targetHash } : {}), ...(relativePath.endsWith(".md") ? { id: pageId(sourceBytes.toString("utf8")) } : {}), status: targetHash === undefined ? "imported" : targetHash === sourceHash ? "already-present" : "collision" });
	}
	return {
		sourceFiles: entries.length,
		importedFiles: entries.filter((entry) => entry.status === "imported").length,
		skippedFiles: entries.filter((entry) => entry.status === "already-present").length,
		collisions: entries.filter((entry) => entry.status === "collision").length,
		unresolvedMoves: entries.filter((entry) => entry.status === "unresolved").length,
		ignoredFiles: ignoredFiles.sort(),
		stableIds: entries.filter((entry): entry is MigrationReconciliationEntry & { id: string } => Boolean(entry.id)).map((entry) => ({ sourcePath: entry.sourcePath, id: entry.id })),
		contentHashes: entries.map((entry) => ({ sourcePath: entry.sourcePath, hash: entry.sourceHash })),
		sourceMappings: entries.map((entry) => ({ sourcePath: entry.sourcePath, targetPath: entry.targetPath, ...(entry.id ? { id: entry.id } : {}) })),
		entries,
	};
}

export interface ShadowComparison<T> {
	equal: boolean;
	onlyLegacy: T[];
	onlyNew: T[];
}

export function compareShadowResults<T>(legacy: T[], current: T[], key: (value: T) => string = (value) => JSON.stringify(value)): ShadowComparison<T> {
	const newKeys = new Set(current.map(key));
	const legacyKeys = new Set(legacy.map(key));
	return { equal: legacy.length === current.length && legacy.every((value) => newKeys.has(key(value))), onlyLegacy: legacy.filter((value) => !newKeys.has(key(value))), onlyNew: current.filter((value) => !legacyKeys.has(key(value))) };
}

export class MigrationRollout {
	private index = 0;
	private readonly evidence = new Map<MigrationRolloutStage, { passed: boolean; details: Record<string, unknown> }>();
	stage(): MigrationRolloutStage { return rolloutStages[this.index]!; }
	recordEvidence(stage: MigrationRolloutStage, evidence: Record<string, unknown> = {}): void { if (!evidence || evidence.passed !== true) throw new Error("migration evidence must explicitly pass"); this.evidence.set(stage, { passed: true, details: { ...evidence } }); }
	evidenceFor(stage: MigrationRolloutStage): Record<string, unknown> | undefined { return this.evidence.get(stage)?.details; }
	advance(expected: MigrationRolloutStage): MigrationRolloutStage {
		if (this.stage() !== expected) throw new Error("migration stage is not ready");
		if (this.index >= rolloutStages.length - 1) throw new Error("migration rollout is already complete");
		this.index += 1;
		return this.stage();
	}
	advanceWithEvidence(expected: MigrationRolloutStage, evidence: Record<string, unknown>): MigrationRolloutStage { this.recordEvidence(expected, evidence); return this.advance(expected); }
	assertReleaseReady(options: { legacyRetained: boolean; rollbackWindowDays: number }): void { if (!options.legacyRetained || !Number.isInteger(options.rollbackWindowDays) || options.rollbackWindowDays < 1) throw new Error("legacy rollback window is required"); if (this.stage() !== "full-automation" || rolloutStages.some((stage) => !this.evidence.get(stage)?.passed)) throw new Error("migration rollout evidence is incomplete"); }
	rollback(): MigrationRolloutStage {
		if (this.index === 0) throw new Error("migration rollout is already at the legacy stage");
		this.index -= 1;
		return this.stage();
	}
}

export interface RollbackDrillResult { passed: boolean; steps: string[]; legacyRetained: boolean; completedAt: string; }
export interface RollbackDrillActions { switchReadsToLegacy(): Promise<void>; rebuildFromGitCommit(): Promise<void>; restorePostgres(): Promise<void>; disableHostedWrites(): Promise<void>; revokeTokens(): Promise<void>; restoreRemoteBackup(): Promise<void>; recoverLocalModel(): Promise<void>; recoverPostgresOutage(): Promise<void>; }

export async function runRollbackDrill(actions: RollbackDrillActions, options: { legacyRetained: boolean; now?: Date }): Promise<RollbackDrillResult> {
	if (!options.legacyRetained) throw new Error("legacy assets must remain available during rollback drills");
	const steps: string[] = [];
	for (const [name, action] of Object.entries(actions)) { await action(); steps.push(name); }
	return { passed: true, steps, legacyRetained: options.legacyRetained, completedAt: (options.now ?? new Date()).toISOString() };
}

export async function migrateLegacyArchive(source: string, repository: RepositoryLike): Promise<{ copied: number; documents: number; commit: string }> {
	const sourceRoot = resolve(source);
	const targetRoot = resolve(repository.root);
	if (sourceRoot === targetRoot || targetRoot.startsWith(`${sourceRoot}${sep}`)) throw new Error("brain repository must be separate from legacy archive");
	await repository.initialize();
	const files: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error("legacy archive contains a symlink");
			if (entry.isDirectory()) { if (entry.name !== ".git" && entry.name !== ".brain") await visit(path); continue; }
			if (entry.isFile()) files.push(path);
		}
	};
	await visit(sourceRoot);
	for (const sourcePath of files) {
		const targetPath = join(targetRoot, safeRelative(sourceRoot, sourcePath));
		try {
			await lstat(targetPath);
			throw new Error("legacy migration target path already exists");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const manifest: Array<{ id: string; path: string; contentHash: string; revision: string }> = [];
	for (const sourcePath of files.sort()) {
		const path = safeRelative(sourceRoot, sourcePath);
		const targetPath = join(targetRoot, path);
		await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
		await copyFile(sourcePath, targetPath);
		await chmod(targetPath, 0o600);
		if (path.endsWith(".md")) {
			const content = await readFile(sourcePath);
			const contentHash = hash(content);
			manifest.push({ id: pageId(content.toString("utf8")), path, contentHash, revision: contentHash });
		}
	}
	const manifestPath = join(targetRoot, ".brain", "manifest.jsonl");
	await writeFile(manifestPath, manifest.map((item) => JSON.stringify(item)).join("\n") + (manifest.length ? "\n" : ""), { mode: 0o600 });
	const ownedPaths = [...files.map((path) => safeRelative(sourceRoot, path)), join(".brain", "identity.json"), join(".brain", "settings.json"), join(".brain", "manifest.jsonl")];
	await git(targetRoot, ["add", "--", ...ownedPaths]);
	await git(targetRoot, ["commit", "--only", "-m", "brain: import legacy archive", "--", ...ownedPaths]);
	return { copied: files.length, documents: manifest.length, commit: await git(targetRoot, ["rev-parse", "HEAD"]) };
}
