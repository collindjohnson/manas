import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface SetupPersistenceDependencies {
	ensureDirectory(path: string): Promise<void>;
	write(path: string, content: string): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	fsync(path: string): Promise<void>;
	rename(source: string, target: string): Promise<void>;
	remove(path: string): Promise<void>;
}

export async function defaultSetupPersistenceDependencies(): Promise<SetupPersistenceDependencies> {
	return {
		ensureDirectory: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
		write: async (path, content) => { await Bun.write(path, content); },
		chmod,
		fsync: async (path) => { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } },
		rename,
		remove: async (path) => { await rm(path, { force: true }); },
	};
}

export async function writeSetupConfiguration(path: string, configuration: unknown, dependencies?: SetupPersistenceDependencies): Promise<void> {
	const target = resolve(path);
	const actions = dependencies ?? await defaultSetupPersistenceDependencies();
	await actions.ensureDirectory(dirname(target));
	const staged = `${target}.stage-${process.pid}`;
	await actions.remove(staged);
	try {
		await actions.write(staged, JSON.stringify(configuration, null, 2) + "\n");
		await actions.chmod(staged, 0o600);
		await actions.fsync(staged);
		await actions.rename(staged, target);
		await actions.chmod(target, 0o600);
	} finally {
		await actions.remove(staged);
	}
}
