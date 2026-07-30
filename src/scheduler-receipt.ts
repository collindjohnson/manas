import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ScheduledSyncReceipt {
	runId: string;
	executable: string;
	configPath: string;
	startedAt: string;
	finishedAt: string;
	status: "success" | "failed";
	report: unknown;
}

function safeReceiptId(value: string): string {
	return [...value].map((character) => {
		const code = character.charCodeAt(0);
		return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || "._-".includes(character) ? character : "_";
	}).join("");
}

export async function writeScheduledSyncReceipt(stateRoot: string, receipt: ScheduledSyncReceipt): Promise<string> {
	const directory = resolve(stateRoot, "scheduled-receipts");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const safeId = safeReceiptId(receipt.runId);
	if (!safeId) throw new Error("scheduled receipt run ID is invalid");
	const path = join(directory, `${safeId}.json`);
	await writeFile(path, JSON.stringify(receipt) + "\n", { mode: 0o600 });
	await chmod(path, 0o600);
	return path;
}

export async function newestScheduledSyncReceipt(
	stateRoot: string,
	after: string,
): Promise<ScheduledSyncReceipt | undefined> {
	const directory = resolve(stateRoot, "scheduled-receipts");
	let names: string[];
	try { names = await readdir(directory); } catch { return undefined; }
	const threshold = new Date(after).getTime();
	const receipts = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
		try { return await Bun.file(join(directory, name)).json() as ScheduledSyncReceipt; }
		catch { return undefined; }
	}));
	return receipts.filter((receipt): receipt is ScheduledSyncReceipt => Boolean(receipt))
		.filter((receipt) => new Date(receipt.startedAt).getTime() >= threshold)
		.sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())[0];
}

export async function waitForScheduledSyncReceipt(
	stateRoot: string,
	after: string,
	timeoutMs: number,
): Promise<ScheduledSyncReceipt | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const receipt = await newestScheduledSyncReceipt(stateRoot, after);
		if (receipt) return receipt;
		await Bun.sleep(Math.min(250, Math.max(1, deadline - Date.now())));
	}
	return undefined;
}
