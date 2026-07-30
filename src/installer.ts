import { copyFile, chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

export type BinaryInstallStatus = "installed" | "upgraded" | "unchanged";

export interface BinaryInstallerDependencies {
	hash(path: string): Promise<string>;
	version(path: string): Promise<string>;
	copy(source: string, target: string): Promise<void>;
	fsync(path: string): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	rename(source: string, target: string): Promise<void>;
	remove(path: string): Promise<void>;
	ensureDirectory(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

async function fileHash(path: string): Promise<string> {
	return createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
}

async function exists(path: string): Promise<boolean> {
	try { await stat(path); return true; } catch { return false; }
}

export async function defaultBinaryInstallerDependencies(): Promise<BinaryInstallerDependencies> {
	return {
		hash: fileHash,
		version: async (path) => {
			const process = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
			const output = (await new Response(process.stdout).text()).trim();
			if (await process.exited) return output;
			return output;
		},
		copy: copyFile,
		fsync: async (path) => { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } },
		chmod,
		rename,
		remove: async (path) => { await rm(path, { force: true }); },
		ensureDirectory: async (path) => { await mkdir(path, { recursive: true, mode: 0o755 }); },
		exists,
	};
}

export interface InstallCompiledBinaryOptions {
	source: string;
	destination: string;
	version: string;
	dependencies?: BinaryInstallerDependencies;
}

export async function installCompiledBinary(options: InstallCompiledBinaryOptions): Promise<{ status: BinaryInstallStatus; path: string; sha256: string }> {
	const source = resolve(options.source);
	const destination = resolve(options.destination);
	const dependencies = options.dependencies ?? await defaultBinaryInstallerDependencies();
	const sourceHash = await dependencies.hash(source);
	const directory = dirname(destination);
	await dependencies.ensureDirectory(directory);
	if (await dependencies.exists(destination)) {
		const installedHash = await dependencies.hash(destination);
		const installedVersion = await dependencies.version(destination);
		if (installedHash === sourceHash && installedVersion === options.version)
			return { status: "unchanged", path: destination, sha256: sourceHash };
	}
	const staged = `${destination}.stage-${process.pid}`;
	const backup = `${destination}.previous-${process.pid}`;
	await dependencies.remove(staged);
	await dependencies.remove(backup);
	try {
		await dependencies.copy(source, staged);
		await dependencies.fsync(staged);
		await dependencies.chmod(staged, 0o755);
		if (await dependencies.hash(staged) !== sourceHash) throw new Error("staged binary hash verification failed");
		if (await dependencies.version(staged) !== options.version) throw new Error("staged binary version verification failed");
		const hadDestination = await dependencies.exists(destination);
		if (hadDestination) await dependencies.rename(destination, backup);
		try { await dependencies.rename(staged, destination); } catch (error) {
			if (hadDestination && await dependencies.exists(backup)) await dependencies.rename(backup, destination);
			throw error;
		}
		await dependencies.remove(backup);
		return { status: hadDestination ? "upgraded" : "installed", path: destination, sha256: sourceHash };
	} finally {
		await dependencies.remove(staged);
		if (await dependencies.exists(backup) && !(await dependencies.exists(destination))) await dependencies.rename(backup, destination);
	}
}
