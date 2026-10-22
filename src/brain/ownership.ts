import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

export class StoreOwnedError extends Error {
	readonly code = "store_owned";
	readonly retryable = true;
	readonly suggestedFix = "Connect through the local Manas service, or stop the process owning this store.";
	constructor() { super("The Manas store is already owned by another runtime."); }
}

// A kernel-released SQLite transaction. Never unlink the permanent lock file.
export async function acquireStoreOwnership(directory: string): Promise<() => void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const root = await realpath(directory);
	const path = join(root, ".manas-owner.sqlite");
	try { if ((await lstat(path)).isSymbolicLink()) throw new Error("store ownership file cannot be a symbolic link"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const database = new Database(path, { create: true });
	try {
		await chmod(path, 0o600);
		database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
	} catch (error) {
		database.close();
		if ((error as { code?: string }).code === "SQLITE_BUSY") throw new StoreOwnedError();
		throw error;
	}
	let closed = false;
	return () => { if (!closed) { closed = true; database.close(); } };
}
