import { describe, expect, test } from "bun:test";
import { activateAndVerifyMacScheduler } from "@manas/scheduler-activation";

const root = String.fromCharCode(47);
const request = {
	plistPath: root + "agent.plist",
	uid: 501,
	label: "com.collindjohnson.manas",
	executable: root + "bin/manas",
	configPath: root + "config.json",
	startedAt: "2026-01-01T00:00:00.000Z",
};

describe("macOS scheduler activation", () => {
	test("reloads, kickstarts, and verifies matching receipt evidence", async () => {
		const commands: string[][] = [];
		const receipt = await activateAndVerifyMacScheduler(request, {
			run: async (command) => { commands.push(command); return command[1] === "print" ? 0 : 0; },
			waitForReceipt: async () => ({ executable: request.executable, configPath: request.configPath, startedAt: request.startedAt, status: "success", report: { totals: {} } }),
		});
		expect(receipt.status).toBe("success");
		expect(commands.map((command) => command[1])).toEqual(["print", "bootout", "bootstrap", "kickstart", "print"]);
	});

	test("fails closed for missing, failed, or mismatched receipt evidence", async () => {
		const base = { run: async (_command: string[]) => 0 };
		await expect(activateAndVerifyMacScheduler(request, { ...base, waitForReceipt: async () => undefined })).rejects.toThrow("timed out");
		await expect(activateAndVerifyMacScheduler(request, { ...base, waitForReceipt: async () => ({ executable: request.executable, configPath: request.configPath, startedAt: request.startedAt, status: "failed", report: {} }) })).rejects.toThrow("scheduled sync failed");
		await expect(activateAndVerifyMacScheduler(request, { ...base, waitForReceipt: async () => ({ executable: root + "other", configPath: request.configPath, startedAt: request.startedAt, status: "success", report: {} }) })).rejects.toThrow("unexpected executable");
	});

	test("fails closed when post-activation archive or log evidence is missing", async () => {
		const base = {
			run: async () => 0,
			waitForReceipt: async () => ({ executable: request.executable, configPath: request.configPath, startedAt: request.startedAt, status: "success" as const, report: {} }),
		};
		await expect(activateAndVerifyMacScheduler(request, { ...base, verifyArchive: async () => ({ ok: false, errors: ["bad archive"] }) })).rejects.toThrow("archive verification failed");
		await expect(activateAndVerifyMacScheduler(request, { ...base, verifyArchive: async () => ({ ok: true, errors: [] }), verifyLog: async () => false })).rejects.toThrow("log verification failed");
	});
});
