import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface BackupEntry {
	path: string;
	bytes: number;
	sha256: string;
}
export interface BackupReport {
	source: string;
	destination?: string;
	entries: BackupEntry[];
	bytes: number;
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function collect(root: string, current: string, entries: BackupEntry[]): Promise<void> {
	for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
		const path = join(current, entry.name);
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink()) throw new Error(`backup refuses symlink: ${relative(root, path)}`);
		if (metadata.isDirectory()) await collect(root, path, entries);
		else if (metadata.isFile()) {
			const bytes = await readFile(path);
			entries.push({ path: relative(root, path), bytes: bytes.byteLength, sha256: digest(bytes) });
		} else throw new Error(`backup refuses special file: ${relative(root, path)}`);
	}
}

export async function inventoryBackup(rootPath: string): Promise<BackupReport> {
	const root = resolve(rootPath);
	const metadata = await lstat(root);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("backup root must be a regular directory");
	const entries: BackupEntry[] = [];
	await collect(root, root, entries);
	return { source: root, entries, bytes: entries.reduce((total, entry) => total + entry.bytes, 0) };
}

export async function createRepositoryBackup(sourcePath: string, destinationPath: string): Promise<BackupReport> {
	const source = await inventoryBackup(sourcePath);
	const sourceRoot = resolve(sourcePath);
	const destination = resolve(destinationPath);
	if (sourceRoot === destination || destination.startsWith(`${sourceRoot}/`)) throw new Error("backup destination must be outside the source");
	await mkdir(destination, { recursive: true });
	for (const entry of source.entries) {
		const target = join(destination, entry.path);
		await mkdir(join(target, ".."), { recursive: true });
		await copyFile(join(sourceRoot, entry.path), target, 0);
	}
	const verified = await inventoryBackup(destination);
	if (JSON.stringify(source.entries) !== JSON.stringify(verified.entries)) throw new Error("backup verification failed");
	return { ...verified, destination };
}

export async function verifyRepositoryBackup(sourcePath: string, backupPath: string): Promise<{ valid: boolean; missing: string[]; changed: string[]; extra: string[] }> {
	const source = await inventoryBackup(sourcePath);
	const backup = await inventoryBackup(backupPath);
	const sourceByPath = new Map(source.entries.map((entry) => [entry.path, entry]));
	const backupByPath = new Map(backup.entries.map((entry) => [entry.path, entry]));
	const missing = [...sourceByPath.keys()].filter((path) => !backupByPath.has(path)).sort();
	const changed = [...sourceByPath.keys()].filter((path) => {
		const candidate = backupByPath.get(path);
		return candidate !== undefined && (candidate.sha256 !== sourceByPath.get(path)!.sha256 || candidate.bytes !== sourceByPath.get(path)!.bytes);
	}).sort();
	const extra = [...backupByPath.keys()].filter((path) => !sourceByPath.has(path)).sort();
	return { valid: missing.length === 0 && changed.length === 0 && extra.length === 0, missing, changed, extra };
}
