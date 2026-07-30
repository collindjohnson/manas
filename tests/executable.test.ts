import { describe, expect, test } from "bun:test";
import { executableCommand } from "@manas/executable";

const root = String.fromCharCode(47);

describe("executableCommand", () => {
	test("uses the compiled executable alone", () => {
		const binary = root + "opt" + root + "manas";
		expect(executableCommand({ execPath: binary, entrypoint: binary })).toEqual([binary]);
	});

	test("uses the physical Bun executable and an absolute source entrypoint", () => {
		const bun = root + "bun";
		const source = root + "work" + root + "cli.ts";
		expect(executableCommand({ execPath: bun, bunPath: bun, entrypoint: source })).toEqual([bun, source]);
	});

	test("rejects source execution without a Bun executable", () => {
		expect(() => executableCommand({ execPath: root + "bun", entrypoint: root + "work" + root + "cli.ts" })).toThrow("physical Bun executable");
	});
});
