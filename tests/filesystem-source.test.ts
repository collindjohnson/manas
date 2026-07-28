import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modulePath = ["..", "src", "sources", "filesystem"].join(String.fromCharCode(47));
const { FilesystemSourceAdapter } = await import(modulePath);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("filesystem source adapter", () => {
	test("normalizes Markdown and text deterministically while skipping symlinks", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-source-"));
		roots.push(root);
		await writeFile(join(root, "note.md"), "# Note\n");
		await writeFile(join(root, "plain.txt"), "plain text");
		await symlink(join(root, "note.md"), join(root, "linked.md"));
		const first = await new FilesystemSourceAdapter(root).list();
		const second = await new FilesystemSourceAdapter(root).list();
		expect(first.map((item: any) => item.suggestedPath)).toEqual([join("files", "note.md"), join("files", "plain.md")]);
		expect(first.map((item: any) => item.externalId)).toEqual(second.map((item: any) => item.externalId));
		expect(first[1]?.content).toContain("plain text");
		expect(new FilesystemSourceAdapter(root).describe()).toMatchObject({ kind: "filesystem", version: "1" });
		expect(await Array.fromAsync(new FilesystemSourceAdapter(root).scan({ updatedAt: "9999-01-01T00:00:00.000Z" }))).toEqual([]);
	});
});
