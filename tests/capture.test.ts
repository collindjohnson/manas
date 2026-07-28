import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const captureModule = ["..", "src", "brain", "capture"].join(String.fromCharCode(47));
const repositoryModule = ["..", "src", "brain", "repository"].join(String.fromCharCode(47));
const { captureBrainNote } = await import(captureModule);
const { BrainRepository } = await import(repositoryModule);
const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("brain capture", () => {
	test("creates an idempotent inbox page", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-capture-"));
		roots.push(root);
		const brain = new BrainRepository(join(root, "brain"));
		await brain.initialize();
		await execFile("git", ["-C", brain.root, "config", "user.name", "Test"]);
		await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
		const now = new Date("2026-07-24T12:00:00.000Z");
		const first = await captureBrainNote(brain, "remember this", now);
		const second = await captureBrainNote(brain, "remember this", now);
		expect(first).toMatchObject({ created: true, path: expect.stringContaining("inbox/2026-07-24-"), schemaPack: { id: "default", version: "1" } });
		expect(second).toMatchObject({ created: false, id: first.id });
	});
});
