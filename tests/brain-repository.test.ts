import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const modulePath = ["..", "src", "brain", "repository"].join(String.fromCharCode(47));
const { BrainRepository, DEFAULT_BRAIN_DIRECTORIES } = await import(modulePath);
const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "chat-history-brain-repository-"));
	roots.push(root);
	const brain = new BrainRepository(join(root, "brain"));
	await brain.initialize();
	await execFile("git", ["-C", brain.root, "config", "user.name", "Test User"]);
	await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
	return brain;
}

describe("brain repository", () => {
	test("initializes a separate Git repository with the standard directories", async () => {
		const brain = await fixture();
		for (const directory of DEFAULT_BRAIN_DIRECTORIES) expect((await lstat(join(brain.root, directory))).isDirectory()).toBe(true);
		expect(await Bun.file(join(brain.root, ".brain", "manifest.jsonl")).exists()).toBe(true);
		expect(JSON.parse(await readFile(join(brain.root, ".brain", "settings.json"), "utf8"))).toEqual({ schemaPack: { id: "default", version: "1" }, sources: {} });
		expect((await execFile("git", ["-C", brain.root, "rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe("true");
		expect(await brain.head()).toBeUndefined();
	});

	test("preserves ordinary Markdown and revision checks through recovery", async () => {
		const brain = await fixture();
		const created = await brain.putPage(join("notes", "plain.md"), "# Plain\n\nNo frontmatter\n");
		expect(await readFile(join(brain.root, "notes", "plain.md"), "utf8")).toBe(created.content);
		await expect(brain.putPage(join("notes", "plain.md"), "changed", "wrong")).rejects.toThrow("stale brain page revision");
		const moved = await brain.movePage(join("notes", "plain.md"), join("inbox", "plain.md"), created.revision);
		const deleted = await brain.deletePage(join("inbox", "plain.md"), moved.revision);
		expect(deleted.deletedAt).toBeString();
		const restored = await brain.restorePage(deleted.id, join("notes", "restored.md"), deleted.revision);
		expect(restored.id).toBe(created.id);
	});

	test("keeps protected metadata paths outside ordinary move targets", async () => {
		const brain = await fixture();
		const page = await brain.putPage(join("notes", "protected.md"), "safe");
		await expect(
			brain.movePage(join("notes", "protected.md"), join(".brain", "identity.json"), page.revision),
		).rejects.toThrow("invalid brain page path");
	});

	test("commits only owned paths", async () => {
		const brain = await fixture();
		await writeFile(join(brain.root, "unrelated.md"), "do not stage");
		const page = await brain.putPage(join("notes", "owned.md"), "owned");
		const status = (await execFile("git", ["-C", brain.root, "status", "--short"])).stdout;
		expect(status).toContain("?? unrelated.md");
		const changed = (await execFile("git", ["-C", brain.root, "show", "--format=", "--name-only", page.commit])).stdout.split("\n").filter(Boolean).sort();
		expect(changed).toEqual([join(".brain", "identity.json"), join(".brain", "manifest.jsonl"), join(".brain", "settings.json"), join("notes", "owned.md")]);
		const commitBody = (await execFile("git", ["-C", brain.root, "show", "-s", "--format=%B", page.commit])).stdout;
		expect(commitBody).toContain("Brain-Operation: put");
		expect(commitBody).toContain("Brain-Correlation-ID:");
	});

	test("rejects a pre-existing change in an operation-owned path", async () => {
		const brain = await fixture();
		const page = await brain.putPage(join("notes", "conflict.md"), "first");
		await writeFile(join(brain.root, "notes", "conflict.md"), "manual draft");
		await expect(
			brain.putPage(join("notes", "conflict.md"), "second", page.revision),
		).rejects.toThrow("operation-owned paths");
		expect(await readFile(join(brain.root, "notes", "conflict.md"), "utf8")).toBe("manual draft");
	});

	test("creates immutable snapshots, verifies exact bytes, and rejects stale heads", async () => {
		const brain = await fixture();
		const page = await brain.putPage(join("notes", "snapshot.md"), "snapshot body\n");
		expect(await brain.head()).toBe(page.commit);
		const snapshot = await brain.snapshot(page.commit);
		expect((await brain.readPage(snapshot, page.id)).content).toBe("snapshot body\n");
		expect(snapshot.settings.schemaPack).toEqual({ id: "default", version: "1" });
		expect(await brain.verify(page.commit)).toMatchObject({ commit: page.commit, valid: true, issues: [] });
		await expect(brain.mutate({ type: "put", path: join("notes", "snapshot.md"), content: "new body", expectedRevision: page.revision, expectedHead: "not-a-head" })).rejects.toThrow("stale brain repository head");
	});

	test("changes the active schema pack through a scoped Git commit", async () => {
		const brain = await fixture();
		const page = await brain.putPage(join("notes", "schema.md"), "body");
		const installed = await brain.installSchemaPack({ id: "personal", version: "2", pathTypes: { "journal/": "entry" } }, page.commit);
		expect((await brain.listSchemaPacks()).map((pack: { id: string; version: string }) => `${pack.id}@${pack.version}`)).toContain("personal@2");
		const changed = await brain.setSchemaPack({ id: "personal", version: "2" }, installed.commit);
		expect(changed.settings.schemaPack).toEqual({ id: "personal", version: "2" });
		expect((await brain.snapshot(changed.commit)).settings.schemaPack).toEqual({ id: "personal", version: "2" });
		await expect(brain.installSchemaPack({ id: "personal", version: "2", pathTypes: { "journal/": "note" } }, changed.commit)).rejects.toThrow("schema pack version already exists");
		await expect(brain.setSchemaPack({ id: "unknown", version: "1" }, changed.commit)).rejects.toThrow("schema pack is not installed");
	});

	test("commits source descriptors as authoritative settings", async () => {
		const brain = await fixture();
		const page = await brain.putPage(join("notes", "source.md"), "body");
		const registered = await brain.registerSourceDescriptor({ id: "filesystem", version: "1", kind: "filesystem", trusted: true }, page.commit);
		expect(registered.settings.sources.filesystem).toEqual({ type: "filesystem", version: "1", kind: "filesystem", trusted: true });
		expect((await brain.snapshot(registered.commit)).settings.sources.filesystem?.trusted).toBe(true);
	});

	test("stores logical access labels in immutable manifest history", async () => {
		const brain = await fixture();
		const page = await brain.putPage(join("notes", "private.md"), "body");
		const changed = await brain.setPageAccessLabels(join("notes", "private.md"), ["team", "private", "team"], page.revision, page.commit);
		expect(changed.accessLabels).toEqual(["private", "team"]);
		expect((await brain.snapshot(changed.commit)).pages.find((entry: { id: string }) => entry.id === page.id)?.accessLabels).toEqual(["private", "team"]);
	});

	test("permanently purges only a retention-expired deleted page", async () => {
		const brain = await fixture();
		const page = await brain.putPage(join("notes", "purge.md"), "body");
		const deleted = await brain.deletePage(page.path, page.revision, page.commit);
		await expect(brain.purgeDeletedPage(deleted.id, deleted.commit)).rejects.toThrow("retention period");
		const purged = await brain.purgeDeletedPage(deleted.id, deleted.commit, 1, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
		expect((await brain.listPages(true)).some((entry: { id: string }) => entry.id === deleted.id)).toBe(false);
		expect(await brain.head()).toBe(purged.commit);
	});

	test("reads page history from immutable Git commits", async () => {
		const brain = await fixture();
		const first = await brain.putPage(join("notes", "history.md"), "first");
		await brain.putPage(join("notes", "history.md"), "second", first.revision);
		const history = await brain.pageHistory(join("notes", "history.md"));
		expect(history).toHaveLength(2);
		expect(history.map((entry: { message: string }) => entry.message)).toEqual(["brain: put notes/history.md", "brain: put notes/history.md"]);
	});

	test("reverts a page from immutable Git bytes", async () => {
		const brain = await fixture();
		const first = await brain.putPage(join("notes", "revert.md"), "first");
		const second = await brain.putPage(join("notes", "revert.md"), "second", first.revision);
		const reverted = await brain.revertPage(join("notes", "revert.md"), first.commit, second.revision, second.commit);
		expect(reverted.content).toBe("first");
		expect(reverted.id).toBe(first.id);
	});

	test("recovers an expired cross-process mutation lease", async () => {
		const brain = await fixture();
		await writeFile(join(brain.root, ".brain", "mutation.lock"), JSON.stringify({ token: "crashed", expiresAt: Date.now() - 1 }));
		const page = await brain.putPage(join("notes", "lease.md"), "recovered");
		expect(page.content).toBe("recovered");
		expect(await Bun.file(join(brain.root, ".brain", "mutation.lock")).exists()).toBe(false);
	});

	test("retains a stable ID for an unambiguous manual rename", async () => {
		const brain = await fixture();
		const page = await brain.putPage(join("notes", "before.md"), "same content");
		await rename(join(brain.root, "notes", "before.md"), join(brain.root, "notes", "after.md"));
		expect(await brain.reconcileManifest()).toEqual({ created: 0, renamed: 1, warnings: [] });
		expect((await brain.getPage(join("notes", "after.md")))?.id).toBe(page.id);
	});
});
