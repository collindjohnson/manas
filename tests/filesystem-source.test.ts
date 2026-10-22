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
		expect(await Array.fromAsync(new FilesystemSourceAdapter(root).scan({ updatedAt: "9999-01-01T00:00:00.000Z" }))).toHaveLength(2);
	});
});

test("fingerprint checkpoints include late files and same-timestamp edits, and reconcile legacy cursors", async () => {
 const { utimes } = await import("node:fs/promises");
 const root = await mkdtemp(join(tmpdir(), "brain-source-cursor-")); roots.push(root);
 const old = new Date("2020-01-01T00:00:00Z");
 await writeFile(join(root, "one.md"), "original"); await utimes(join(root, "one.md"), old, old);
 const adapter = new FilesystemSourceAdapter(root);
 expect(await Array.fromAsync(adapter.scan({ updatedAt: "2099-01-01T00:00:00Z" }))).toHaveLength(1);
 const checkpoint = adapter.checkpoint();
 expect(await Array.fromAsync(new FilesystemSourceAdapter(root).scan(checkpoint))).toEqual([]);
 await writeFile(join(root, "one.md"), "edited"); await utimes(join(root, "one.md"), old, old);
 await writeFile(join(root, "late.md"), "late"); await utimes(join(root, "late.md"), old, old);
 expect((await Array.fromAsync(adapter.scan(checkpoint))).map((item: any) => item.content).sort()).toEqual(["edited", "late"]);
 expect(await Array.fromAsync(adapter.scan(adapter.checkpoint()))).toEqual([]);
 expect(await Array.fromAsync(adapter.scan({ cursor: "unrecognized" }))).toHaveLength(2);
});

test("an interrupted scan does not publish an incomplete fingerprint cursor", async () => {
 const root = await mkdtemp(join(tmpdir(), "brain-source-interrupted-")); roots.push(root);
 await writeFile(join(root, "one.md"), "one"); await writeFile(join(root, "two.md"), "two");
 const adapter = new FilesystemSourceAdapter(root);
 const scan = adapter.scan();
 expect((await scan.next()).done).toBe(false);
 await scan.return(undefined);
 expect(adapter.checkpoint().cursor).toBeUndefined();
 expect(await Array.fromAsync(adapter.scan(adapter.checkpoint()))).toHaveLength(2);
});
