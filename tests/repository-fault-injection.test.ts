import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import {
	BrainRepository,
	REPOSITORY_FAULT_POINTS,
	type RepositoryFaultPoint,
} from "../src/brain/repository";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; brain: BrainRepository }> {
	const root = await mkdtemp(join(tmpdir(), "chat-history-fault-injection-"));
	roots.push(root);
	const brain = new BrainRepository(join(root, "brain"));
	await brain.initialize();
	await execFile("git", ["-C", brain.root, "config", "user.name", "Test User"]);
	await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
	return { root, brain };
}

describe("repository fault recovery", () => {
	test("leaves no committed mutation at every pre-commit boundary", async () => {
		for (const point of REPOSITORY_FAULT_POINTS.filter((candidate) => candidate !== "post-commit-cleanup")) {
			const { brain } = await fixture();
			const first = await brain.putPage("notes/fault.md", "first");
			const injected = new BrainRepository(brain.root, {
				faultInjector: async (candidate: RepositoryFaultPoint) => {
					if (candidate === point) throw new Error(`injected ${candidate}`);
				},
			});
			await expect(injected.putPage("notes/fault.md", "second", first.revision, undefined, first.commit)).rejects.toThrow(`injected ${point}`);
			const recovered = new BrainRepository(brain.root);
			expect(await recovered.head()).toBe(first.commit);
			expect(await recovered.verify()).toMatchObject({ commit: first.commit, valid: true, issues: [] });
			expect((await recovered.getPage("notes/fault.md"))?.content).toBe("first");
		}
	});

	test("reports a complete committed mutation when cleanup fails after commit", async () => {
		const { brain } = await fixture();
		const first = await brain.putPage("notes/fault.md", "first");
		const injected = new BrainRepository(brain.root, {
			faultInjector: async (point: RepositoryFaultPoint) => {
				if (point === "post-commit-cleanup") throw new Error("injected post-commit-cleanup");
			},
		});
		await expect(injected.putPage("notes/fault.md", "second", first.revision, undefined, first.commit)).rejects.toThrow("injected post-commit-cleanup");
		const recovered = new BrainRepository(brain.root);
		const head = await recovered.head();
		expect(head).not.toBe(first.commit);
		expect(await recovered.verify()).toMatchObject({ commit: head, valid: true, issues: [] });
		expect((await recovered.getPage("notes/fault.md"))?.content).toBe("second");
	});
});
