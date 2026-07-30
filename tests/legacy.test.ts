import { describe, expect, test } from "bun:test";
import { restoreLegacyInstallation, retireLegacyInstallation } from "@manas/legacy";

describe("legacy retirement", () => {
	test("requires explicit consent and creates backup evidence before unload", async () => {
		const calls: string[] = [];
		const dependencies = {
			copy: async () => { calls.push("copy"); },
			write: async () => { calls.push("manifest"); },
			mkdir: async () => { calls.push("mkdir"); },
			unload: async () => { calls.push("unload"); },
		};
		await expect(retireLegacyInstallation({ plistPath: "legacy.plist", exists: true }, "backup", false, "2026-01-01", dependencies)).rejects.toThrow("explicit consent");
		const result = await retireLegacyInstallation({ plistPath: "legacy.plist", exists: true }, "backup", true, "2026-01-01", dependencies);
		expect(calls).toEqual(["mkdir", "copy", "manifest", "unload"]);
		expect(result?.manifestPath).toContain("manifest.json");
	});

	test("retains the backup when unload fails", async () => {
		const dependencies = { copy: async () => {}, write: async () => {}, mkdir: async () => {}, unload: async () => { throw new Error("failed"); } };
		await expect(retireLegacyInstallation({ plistPath: "legacy.plist", exists: true }, "backup", true, "2026-01-01", dependencies)).rejects.toThrow("backup retained");
	});

	test("restores a manifest-backed legacy agent and reloads it", async () => {
		const calls: string[] = [];
		const root = String.fromCharCode(47);
		const manifest = JSON.stringify({
			schema: "manas.legacy-backup.v1",
			retiredAt: "2026-01-01",
			originalPlist: root + "Library/LaunchAgents/legacy.plist",
			backupPlist: root + "state/legacy-backups/legacy.plist",
		});
		const restored = await restoreLegacyInstallation(root + "state/manifest.json", {
			read: async () => manifest,
			copy: async (source, target) => { calls.push(`${source}:${target}`); },
			load: async (path) => { calls.push(`load:${path}`); },
		});
		expect(restored.originalPlist).toBe(root + "Library/LaunchAgents/legacy.plist");
		expect(calls).toEqual([
			root + "state/legacy-backups/legacy.plist:" + root + "Library/LaunchAgents/legacy.plist",
			"load:" + root + "Library/LaunchAgents/legacy.plist",
		]);
	});

	test("refuses a legacy manifest with relative paths", async () => {
		await expect(restoreLegacyInstallation("manifest.json", {
			read: async () => JSON.stringify({ schema: "manas.legacy-backup.v1", originalPlist: "legacy.plist", backupPlist: "backup.plist" }),
			copy: async () => {},
			load: async () => {},
		})).rejects.toThrow("paths must be absolute");
	});
});
