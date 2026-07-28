import {
	chmod,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { SyncReport } from "./model";

export interface SyncState {
	version: 1;
	lastReport?: SyncReport;
	fingerprints: Record<string, string>;
	sourceCheckpoints?: Record<string, { updatedAt?: string }>;
}

export async function ensureStateRoot(root: string): Promise<void> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	await chmod(root, 0o700);
}

export async function loadState(root: string): Promise<SyncState> {
	await ensureStateRoot(root);
	try {
		const value = JSON.parse(
			await readFile(join(root, "state.json"), "utf8"),
		) as Partial<SyncState>;
		return {
			version: 1,
			fingerprints: value.fingerprints ?? {},
			sourceCheckpoints: value.sourceCheckpoints ?? {},
			lastReport: value.lastReport,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { version: 1, fingerprints: {}, sourceCheckpoints: {} };
		throw error;
	}
}

export async function saveState(root: string, state: SyncState): Promise<void> {
	await ensureStateRoot(root);
	const path = join(root, "state.json");
	const temporary = `${path}.tmp-${process.pid}`;
	await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
		mode: 0o600,
	});
	await chmod(temporary, 0o600);
	await rename(temporary, path);
	await chmod(path, 0o600);
}

async function withLock<T>(
	root: string,
	name: "sync" | "index",
	action: () => Promise<T>,
): Promise<T> {
	await ensureStateRoot(root);
	const lockPath = join(root, `${name}.lock`);
	let handle;
	try {
		handle = await open(lockPath, "wx", 0o600);
		await handle.write(`${process.pid}\n`);
		return await action();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(`${name} already running: ${lockPath}`);
		throw error;
	} finally {
		await handle?.close();
		if (handle) await rm(lockPath, { force: true });
	}
}

export async function withStateLock<T>(
	root: string,
	action: () => Promise<T>,
): Promise<T> {
	return withLock(root, "sync", action);
}

/** Indexing deliberately has an independent lock from archive synchronisation. */
export async function withIndexLock<T>(
	root: string,
	action: () => Promise<T>,
): Promise<T> {
	return withLock(root, "index", action);
}
