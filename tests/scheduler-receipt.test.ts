import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestScheduledSyncReceipt, writeScheduledSyncReceipt } from "@manas/scheduler-receipt";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("scheduled sync receipts", () => {
	test("persists evidence in secure state storage", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-receipt-"));
		roots.push(root);
		const path = await writeScheduledSyncReceipt(root, { runId: "run-1", executable: "manas", configPath: "config", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", status: "success", report: { ok: true } });
		expect(await Bun.file(path).json()).toMatchObject({ runId: "run-1", status: "success" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("finds only receipts created after activation began", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-receipt-"));
		roots.push(root);
		await writeScheduledSyncReceipt(root, { runId: "old", executable: "manas", configPath: "config", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", status: "success", report: {} });
		await writeScheduledSyncReceipt(root, { runId: "new", executable: "manas", configPath: "config", startedAt: "2026-01-02T00:00:00.000Z", finishedAt: "2026-01-02T00:00:01.000Z", status: "success", report: {} });
		expect((await newestScheduledSyncReceipt(root, "2026-01-01T12:00:00.000Z"))?.runId).toBe("new");
	});

	test("rejects scheduled sync from source execution", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-receipt-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		const stateRoot = join(root, "state");
		await Bun.write(configPath, JSON.stringify({
			archiveRoot: join(root, "archive"),
			stateRoot,
			launchAgentPath: join(root, "agent.plist"),
		}));
		const child = Bun.spawn([
			process.execPath,
			"src" + String.fromCharCode(47) + "cli.ts",
			"sync",
			"--scheduled",
			"--config",
			configPath,
			"--provider",
			"not-a-provider",
		], { cwd: import.meta.dir + String.fromCharCode(47) + "..", stdout: "pipe", stderr: "pipe" });
		expect(await child.exited).toBe(1);
		expect(await new Response(child.stdout).text()).toContain("scheduled sync requires an installed release binary");
		expect(existsSync(join(stateRoot, "scheduled-receipts"))).toBe(false);
	});
});
