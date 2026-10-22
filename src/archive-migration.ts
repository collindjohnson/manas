import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, utimes, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import { BrainRepository, configuredGitIdentityArguments, preserveGitBytes } from "./brain/repository";
import { inventoryBackup, type BackupEntry } from "./brain/backup";
import { acquireStoreOwnership } from "./brain/ownership";
import { writeSetupConfiguration } from "./setup-persistence";
import { uuidv5 } from "./utils";
const execFile = promisify(callback);
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export interface ArchiveMigrationReceipt {
	version: 1;
	id: string;
	source: string;
	target: string;
	createdAt: string;
	status: "planned" | "copying" | "committed" | "verified";
	files: Array<BackupEntry & { id?: string; mtimeMs: number; atimeMs: number }>;
	copied: string[];
	commit?: string;
	manifestHash?: string;
	targetHead?: string | null;
}
function contained(root: string, path: string) {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
function validPath(path: string) {
	if (!path || isAbsolute(path) || path.split(/[\\/]/).some((part) => !part || part === "." || part === "..") || [".git", ".brain"].includes(path.split(sep)[0]!) || path.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) throw new Error("unsafe migration path");
}
async function git(root: string, args: string[]) {
	return (await execFile("git", ["-C", root, ...args], { maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
}
function receiptPath(stateRoot: string, id: string) {
	if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid migration receipt ID");
	return join(stateRoot, "archive-migrations", id, "receipt.json");
}
export async function readArchiveMigration(stateRoot: string, id: string): Promise<ArchiveMigrationReceipt> {
	const receipt = JSON.parse(await readFile(receiptPath(stateRoot, id), "utf8")) as ArchiveMigrationReceipt;
	if (receipt.version !== 1 || receipt.id !== id || !Array.isArray(receipt.files) || !isAbsolute(receipt.source) || !isAbsolute(receipt.target)) throw new Error("invalid migration receipt");
	for (const file of receipt.files) validPath(file.path);
	return receipt;
}
async function canonicalPath(path: string): Promise<string> {
	try { return await realpath(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(await canonicalPath(parent), relative(parent, path));
	}
}
export async function previewArchiveMigration(sourcePath: string, targetPath: string, stateRoot: string): Promise<ArchiveMigrationReceipt> {
 try { return await previewArchiveMigrationInternal(sourcePath, targetPath, stateRoot); }
 catch (error) { throw migrationFailure(error); }
}
async function previewArchiveMigrationInternal(sourcePath: string, targetPath: string, stateRoot: string): Promise<ArchiveMigrationReceipt> {
	const source = await realpath(sourcePath);
	const target = await canonicalPath(resolve(targetPath));
	const state = await canonicalPath(resolve(stateRoot));
	if (contained(source, target) || contained(target, source) || contained(target, state) || contained(source, state)) throw new Error("migration source, target, and operational state must be separate");
	const targetRepository = new BrainRepository(target);
	const targetHead = await targetRepository.head();
	if (targetHead && (await targetRepository.snapshot()).pages.length) throw new Error("migration target has existing knowledge; preserve it and choose a fresh target");
	try {
		if ((await readFile(join(target, ".brain", "manifest.jsonl"), "utf8")).trim()) throw new Error("migration target has existing knowledge or an unfinished import; choose a fresh target or resume its receipt");
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const inventory = await inventoryBackup(source);
	const files: ArchiveMigrationReceipt["files"] = [];
	for (const file of inventory.entries) {
		if ([".git", ".brain"].includes(file.path.split(sep)[0]!)) continue;
		validPath(file.path);
		const info = await lstat(join(source, file.path));
		let id: string | undefined;
		if (file.path.endsWith(".md")) {
			const text = await readFile(join(source, file.path), "utf8");
			const existing = text.match(/^(?:manas_id|nessie_id):\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
			id = existing || uuidv5("manas-migration:" + source + ":" + file.path);
		}
		try { await lstat(join(target, file.path)); throw new Error("migration target path already exists: " + file.path); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		files.push({ ...file, ...(id ? { id } : {}), mtimeMs: info.mtimeMs, atimeMs: info.atimeMs });
	}
	if (new Set(files.filter((file) => file.id).map((file) => file.id)).size !== files.filter((file) => file.id).length) throw new Error("archive contains duplicate document IDs");
	const receipt: ArchiveMigrationReceipt = { version: 1, id: randomUUID(), source, target, createdAt: new Date().toISOString(), status: "planned", files, copied: [], targetHead: targetHead ?? null };
	await writeSetupConfiguration(receiptPath(stateRoot, receipt.id), receipt);
	return receipt;
}
async function safeDestination(root: string, path: string) {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const rootInfo = await lstat(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("migration destination root must be a real directory");
	const parts = path.split(sep);
	let current = root;
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		await mkdir(current, { recursive: true, mode: 0o700 });
		const info = await lstat(current);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("migration target contains a symlink");
	}
	return join(root, path);
}
type MigrationApplyOptions = { fault?: (point: "copied" | "committed", path?: string) => Promise<void> | void };
export async function applyArchiveMigration(stateRoot: string, id: string, options: MigrationApplyOptions = {}): Promise<ArchiveMigrationReceipt> {
 try { return await applyArchiveMigrationInternal(stateRoot, id, options); }
 catch (error) { throw migrationFailure(error, id); }
}
function migrationFailure(error: unknown, id?: string) {
 const structured = error as { code?: unknown; retryable?: unknown; suggestedFix?: unknown };
 if (structured && typeof structured.code === "string" && typeof structured.retryable === "boolean" && typeof structured.suggestedFix === "string") return error;
 return Object.assign(error instanceof Error ? error : new Error("Archive migration failed."), { code: "migration_conflict", retryable: false, suggestedFix: id ? "Inspect migration status --id " + id + "; preserve reported source or target edits before resuming that receipt." : "Keep operational state outside the source and target. Preserve existing edits, choose a fresh target, and preview again." });
}
async function applyArchiveMigrationInternal(stateRoot: string, id: string, options: MigrationApplyOptions): Promise<ArchiveMigrationReceipt> {
	const path = receiptPath(stateRoot, id);
	const releaseRuntime = await acquireStoreOwnership(join(stateRoot, "service"));
	let release: (() => void) | undefined;
	try {
		release = await acquireStoreOwnership(dirname(path));
		const receipt = await readArchiveMigration(stateRoot, id);
		const current = (await inventoryBackup(receipt.source)).entries.filter((file) => ![".git", ".brain"].includes(file.path.split(sep)[0]!));
		if (current.length !== receipt.files.length || receipt.files.some((file) => !current.some((entry) => entry.path === file.path && entry.sha256 === file.sha256))) throw new Error("archive changed after migration preview; prepare a new migration");
		const backupRoot = join(dirname(path), "archive-backup");
		for (const file of receipt.files) {
			const backup = await safeDestination(backupRoot, file.path);
			await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
			try { await copyFile(join(receipt.source, file.path), backup, constants.COPYFILE_EXCL); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
			if (digest(await readFile(backup)) !== file.sha256) throw new Error("migration backup failed hash verification");
		}
		const repository = new BrainRepository(receipt.target);
		await repository.initialize();
		if (await realpath(receipt.target) !== receipt.target) throw new Error("migration target must use its canonical path");
		return await repository.withExclusiveMutation(async () => {
			const head = await repository.head();
			const pages = receipt.files.filter((file) => file.id).map((file) => ({
				id: file.id!, path: file.path.split(sep).join("/"), contentHash: file.sha256, revision: file.sha256,
				source: { type: "legacy-archive", externalId: file.id!, updatedAt: new Date(file.mtimeMs).toISOString(), provenance: { sourceType: "legacy-archive", sourcePath: join(receipt.source, file.path), retrievedAt: receipt.createdAt, metadata: { migrationId: id } } },
			}));
			const manifest = pages.map((page) => JSON.stringify(page)).join("\n") + (pages.length ? "\n" : "");
			if (receipt.commit && head !== receipt.commit) throw new Error("migration target changed after its import commit; preserve it and review the receipt");
			if (head && head !== receipt.targetHead) {
				const committedManifest = (await execFile("git", ["-C", repository.root, "show", head + ":.brain/manifest.jsonl"], { maxBuffer: 64 * 1024 * 1024 })).stdout;
				if (committedManifest !== manifest) throw new Error("migration target has unrelated commits; preserve it and choose a fresh target");
				for (const file of receipt.files) {
					const committed = await execFile("git", ["-C", repository.root, "show", head + ":" + file.path.split(sep).join("/")], { encoding: "buffer", maxBuffer: Math.max(32 * 1024 * 1024, file.bytes + 1024) });
					if (digest(committed.stdout) !== file.sha256) throw new Error("committed migration bytes differ from preview");
				}
				receipt.commit = head;
			}
			const workingManifest = await readFile(join(receipt.target, ".brain", "manifest.jsonl"), "utf8");
			if (workingManifest.trim() && workingManifest !== manifest) throw new Error("migration manifest contains unrelated edits");
			if (!receipt.commit) {
				if ((head ?? null) !== (receipt.targetHead ?? null)) throw new Error("migration target changed after preview");
				if (head) {
					if ((await repository.snapshot()).pages.length) throw new Error("migration target has existing knowledge");
					if (await git(receipt.target, ["status", "--porcelain", "--", ".brain/identity.json", ".brain/settings.json"])) throw new Error("migration metadata contains uncommitted edits; preserve them before retrying");
				}
			}
			receipt.status = "copying";
			await writeSetupConfiguration(path, receipt);
			for (const file of receipt.files) {
				const target = await safeDestination(receipt.target, file.path);
				try {
					const info = await lstat(target);
					if (!info.isFile() || info.isSymbolicLink() || digest(await readFile(target)) !== file.sha256) throw new Error("migration collision; retained target edits: " + file.path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					await copyFile(join(backupRoot, file.path), target, constants.COPYFILE_EXCL);
				}
				if (digest(await readFile(target)) !== file.sha256) throw new Error("migration copy failed hash verification");
				await utimes(target, file.atimeMs / 1000, file.mtimeMs / 1000);
				await options.fault?.("copied", file.path);
				if (!receipt.copied.includes(file.path)) receipt.copied.push(file.path);
				await writeSetupConfiguration(path, receipt);
			}
			if (!receipt.commit) {
				for (const file of receipt.files) if (digest(await readFile(join(receipt.target, file.path))) !== file.sha256) throw new Error("migration target changed before commit");
				const manifestPath = join(receipt.target, ".brain", "manifest.jsonl");
				const existingManifest = await readFile(manifestPath, "utf8");
				if (existingManifest.trim() && existingManifest !== manifest) throw new Error("migration manifest contains unrelated edits");
				await writeFile(manifestPath, manifest, { mode: 0o600 });
				const paths = [...receipt.files.map((file) => file.path), ".brain/identity.json", ".brain/settings.json", ".brain/manifest.jsonl"];
				await preserveGitBytes(receipt.target, paths);
				await git(receipt.target, ["add", "-f", "--", ...paths.map((path) => ":(literal)" + path)]);
				await git(receipt.target, [...await configuredGitIdentityArguments(receipt.target), "commit", "--only", "-m", "brain: import archive " + id, "--", ...paths.map((path) => ":(literal)" + path)]);
				receipt.commit = await repository.head();
				await options.fault?.("committed");
			}
			receipt.status = "committed";
			receipt.manifestHash = digest(manifest);
			await writeSetupConfiguration(path, receipt);
			// Working-tree hashes alone cannot detect Git text/filter transformations.
			const committedManifest = await execFile("git", ["-C", receipt.target, "show", receipt.commit + ":.brain/manifest.jsonl"], { maxBuffer: 64 * 1024 * 1024 });
			if (committedManifest.stdout !== manifest) throw gitBytesChanged();
			for (const file of receipt.files) {
				const blob = await execFile("git", ["-C", receipt.target, "show", receipt.commit + ":" + file.path.split(sep).join("/")], { encoding: "buffer", maxBuffer: Math.max(32 * 1024 * 1024, file.bytes + 1024) });
				if (digest(blob.stdout) !== file.sha256) throw gitBytesChanged();
			}
			for (const file of receipt.files) if (digest(await readFile(join(receipt.target, file.path))) !== file.sha256) throw new Error("migration verification found changed target bytes");
			receipt.status = "verified";
			await writeSetupConfiguration(path, receipt);
			return receipt;
		});
	} finally { release?.(); releaseRuntime(); }
}

function gitBytesChanged() {
 return Object.assign(new Error("Git attributes or filters changed the imported bytes; migration is not verified."), { code: "migration_git_bytes_changed", retryable: false, suggestedFix: "Keep the source and migration backup. Review Git text/filter transformations and use a fresh target with byte-preserving attributes before cutover." });
}
