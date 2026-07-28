import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateModule = ["..", "src", "state"].join(String.fromCharCode(47));
const { loadState, saveState } = await import(stateModule);

describe("sync state", () => {
	test("round-trips source checkpoints", async () => {
		const root = await mkdtemp(join(tmpdir(), "manas-state-"));
		await saveState(root, {
			version: 1,
			fingerprints: {},
			sourceCheckpoints: { filesystem: { updatedAt: "2026-07-24T01:00:00.000Z" } },
		});
		expect((await loadState(root)).sourceCheckpoints).toEqual({
			filesystem: { updatedAt: "2026-07-24T01:00:00.000Z" },
		});
	});
});
