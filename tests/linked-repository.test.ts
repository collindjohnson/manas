import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const modulePath = ["..", "src", "sources", "linked-repository"].join(String.fromCharCode(47));
const { LinkedRepositorySourceAdapter } = await import(modulePath);
const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("linked repository source", () => {
	test("records a commit descriptor without copying source code", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-linked-repository-"));
		roots.push(root);
		await execFile("git", ["-C", root, "init"]);
		await execFile("git", ["-C", root, "config", "user.name", "Test"]);
		await execFile("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		await writeFile(join(root, "app.ts"), "export const value = 1;\n");
		await execFile("git", ["-C", root, "add", "app.ts"]);
		await execFile("git", ["-C", root, "commit", "-m", "initial"]);
		const adapter = new LinkedRepositorySourceAdapter(root);
		const [document] = await adapter.list();
		expect(document.content).toContain("does not mirror code");
		expect(document.content).not.toContain("export const value");
		expect(document.provenance.metadata.commit).toHaveLength(40);
		expect(document.contentHash).toHaveLength(64);
		expect(adapter.describe()).toMatchObject({ id: "linked-repository", kind: "linked-repository", version: "1" });
		expect(await Array.fromAsync(adapter.scan({ cursor: adapter.checkpoint().cursor }))).toEqual([]);
	});
});
