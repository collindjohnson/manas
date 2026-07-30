import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface LegacyInstallation {
	plistPath: string;
	exists: boolean;
}

export async function detectLegacyInstallation(plistPath: string): Promise<LegacyInstallation> {
	const resolved = resolve(plistPath);
	try { await stat(resolved); return { plistPath: resolved, exists: true }; }
	catch { return { plistPath: resolved, exists: false }; }
}

export interface RetireLegacyDependencies {
	copy(source: string, target: string): Promise<void>;
	write(path: string, content: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	unload(plistPath: string): Promise<void>;
}

export interface LegacyBackupManifest {
	schema: "manas.legacy-backup.v1";
	retiredAt: string;
	originalPlist: string;
	backupPlist: string;
}

export interface RestoreLegacyDependencies {
	read(path: string): Promise<string>;
	copy(source: string, target: string): Promise<void>;
	load(plistPath: string): Promise<void>;
}

export async function restoreLegacyInstallation(
	manifestPath: string,
	dependencies: RestoreLegacyDependencies,
): Promise<LegacyBackupManifest> {
	const parsed = JSON.parse(await dependencies.read(manifestPath)) as Partial<LegacyBackupManifest>;
	if (parsed.schema !== "manas.legacy-backup.v1" || typeof parsed.originalPlist !== "string" || typeof parsed.backupPlist !== "string")
		throw new Error("legacy backup manifest is invalid");
	const originalPlist = resolve(parsed.originalPlist);
	const backupPlist = resolve(parsed.backupPlist);
	if (originalPlist !== parsed.originalPlist || backupPlist !== parsed.backupPlist)
		throw new Error("legacy backup manifest paths must be absolute");
	await dependencies.copy(backupPlist, originalPlist);
	await dependencies.load(originalPlist);
	return {
		schema: "manas.legacy-backup.v1",
		retiredAt: typeof parsed.retiredAt === "string" ? parsed.retiredAt : "",
		originalPlist,
		backupPlist,
	};
}

export async function retireLegacyInstallation(legacy: LegacyInstallation, backupRoot: string, consent: boolean, timestamp: string, dependencies: RetireLegacyDependencies): Promise<{ backupPath: string; manifestPath: string } | undefined> {
	if (!consent) throw new Error("legacy retirement requires explicit consent");
	if (!legacy.exists) return undefined;
	const backupPath = resolve(backupRoot, `legacy-${timestamp}`);
	await dependencies.mkdir(backupPath);
	const plistCopy = join(backupPath, "com.virdis.chat-history-sync.plist");
	await dependencies.copy(legacy.plistPath, plistCopy);
	const manifestPath = join(backupPath, "manifest.json");
	await dependencies.write(manifestPath, JSON.stringify({ schema: "manas.legacy-backup.v1", retiredAt: timestamp, originalPlist: legacy.plistPath, backupPlist: plistCopy }) + "\n");
	try { await dependencies.unload(legacy.plistPath); }
	catch (error) { throw new Error(`legacy unload failed; backup retained at ${backupPath}: ${error instanceof Error ? error.message : "unknown error"}`); }
	return { backupPath, manifestPath };
}

export async function defaultLegacyDependencies(): Promise<RetireLegacyDependencies> {
	return {
		copy: copyFile,
		write: writeFile,
		mkdir: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
		unload: async (plistPath) => { const command = Bun.spawn(["launchctl", "bootout", `gui${String.fromCharCode(47)}${process.getuid?.() ?? 0}`, plistPath]); if (await command.exited !== 0) throw new Error("launchctl bootout failed"); },
	};
}

export function defaultLegacyRestoreDependencies(): RestoreLegacyDependencies {
	return {
		read: async (path) => readFile(path, "utf8"),
		copy: copyFile,
		load: async (plistPath) => {
			const command = Bun.spawn(["launchctl", "bootstrap", `gui${String.fromCharCode(47)}${process.getuid?.() ?? 0}`, plistPath]);
			if (await command.exited !== 0) throw new Error("launchctl bootstrap failed");
		},
	};
}
