import { describe, expect, test } from "bun:test";
import { writeSetupConfiguration, type SetupPersistenceDependencies } from "@manas/setup-persistence";

describe("setup configuration persistence", () => {
	test("writes, fsyncs, and atomically renames a private staged file", async () => {
		const calls: string[] = [];
		const dependencies: SetupPersistenceDependencies = {
			ensureDirectory: async () => { calls.push("directory"); },
			write: async () => { calls.push("write"); },
			chmod: async (_path, mode) => { calls.push(`chmod-${mode}`); },
			fsync: async () => { calls.push("fsync"); },
			rename: async () => { calls.push("rename"); },
			remove: async () => { calls.push("remove"); },
		};
		await writeSetupConfiguration("config.json", { configVersion: 1 }, dependencies);
		expect(calls).toEqual(["directory", "remove", "write", "chmod-384", "fsync", "rename", "chmod-384", "remove"]);
	});

	test("cleans the staged file after a write failure", async () => {
		const calls: string[] = [];
		const dependencies: SetupPersistenceDependencies = { ensureDirectory: async () => {}, write: async () => { throw new Error("disk full"); }, chmod: async () => {}, fsync: async () => {}, rename: async () => {}, remove: async () => { calls.push("remove"); } };
		await expect(writeSetupConfiguration("config.json", {}, dependencies)).rejects.toThrow("disk full");
		expect(calls).toEqual(["remove", "remove"]);
	});
});
