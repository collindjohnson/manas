import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const migrationModule = ["..", "src", "migration"].join(String.fromCharCode(47));
const repositoryModule = ["..", "src", "brain", "repository"].join(String.fromCharCode(47));
const { MigrationRollout, compareShadowResults, migrateLegacyArchive, reconcileLegacyArchive, runRollbackDrill } = await import(migrationModule);
const { BrainRepository } = await import(repositoryModule);
const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("legacy migration", () => {
	test("copies archive files byte-for-byte and preserves Manas IDs in the new manifest", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-migration-"));
		roots.push(root);
		const legacy = join(root, "legacy");
		await Bun.write(join(legacy, "codex", "chat.md"), "---\nmanas_id: \"KEEP\"\n---\n\nhello\n");
		await writeFile(join(legacy, "binary.dat"), new Uint8Array([0, 1, 2, 3]));
		const brain = new BrainRepository(join(root, "brain"));
		await brain.initialize();
		await execFile("git", ["-C", brain.root, "config", "user.name", "Test"]);
		await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
		const result = await migrateLegacyArchive(legacy, brain);
		expect(result).toMatchObject({ copied: 2, documents: 1 });
		expect(await readFile(join(brain.root, "codex", "chat.md"), "utf8")).toBe("---\nmanas_id: \"KEEP\"\n---\n\nhello\n");
		expect([...await readFile(join(brain.root, "binary.dat"))]).toEqual([0, 1, 2, 3]);
		expect(await readFile(join(brain.root, ".brain", "manifest.jsonl"), "utf8")).toContain('"id":"KEEP"');
		expect((await brain.snapshot(result.commit)).pages).toMatchObject([{ id: "KEEP", path: "codex/chat.md" }]);
	});

	test("aborts before copying when a target page path already exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-migration-"));
		roots.push(root);
		const legacy = join(root, "legacy");
		await Bun.write(join(legacy, "notes", "existing.md"), "legacy");
		const brain = new BrainRepository(join(root, "brain"));
		await brain.initialize();
		await execFile("git", ["-C", brain.root, "config", "user.name", "Test"]);
		await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
		await Bun.write(join(brain.root, "notes", "existing.md"), "current");
		await expect(migrateLegacyArchive(legacy, brain)).rejects.toThrow("target path already exists");
		expect(await readFile(join(brain.root, "notes", "existing.md"), "utf8")).toBe("current");
	});

	test("produces a byte/hash reconciliation report without mutating either side", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-migration-report-"));
		roots.push(root);
		const legacy = join(root, "legacy");
		const target = join(root, "target");
		await Bun.write(join(legacy, "notes", "one.md"), "---\nmanas_id: KEEP\n---\n\none\n");
		await Bun.write(join(legacy, "notes", "two.md"), "two\n");
		await Bun.write(join(legacy, ".hidden"), "ignored\n");
		await Bun.write(join(target, "notes", "one.md"), "---\nmanas_id: KEEP\n---\n\nchanged\n");
		const report = await reconcileLegacyArchive(legacy, target);
		expect(report).toMatchObject({ sourceFiles: 2, importedFiles: 1, collisions: 1, skippedFiles: 0 });
		expect(report.ignoredFiles).toContain(".hidden");
		expect(report.entries.find((entry: { id?: string }) => entry.id === "KEEP")).toMatchObject({ status: "collision", sourcePath: "notes/one.md" });
	});

	test("supports deterministic shadow comparisons and staged rollback", () => {
		expect(compareShadowResults([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }], (value: { id: string }) => value.id)).toMatchObject({ equal: false, onlyLegacy: [{ id: "a" }], onlyNew: [{ id: "c" }] });
		const rollout = new MigrationRollout();
		expect(rollout.advance("legacy")).toBe("byte-preserving-import");
		expect(rollout.advance("byte-preserving-import")).toBe("manifest-commit");
		expect(rollout.rollback()).toBe("byte-preserving-import");
	});

	test("requires evidence for the full cutover and executes every rollback drill step", async () => {
		const rollout = new MigrationRollout();
		const stages = ["legacy", "byte-preserving-import", "manifest-commit", "managed-sections", "projection", "retrieval-shadow", "source-shadow", "new-read-path", "git-writes", "hosted-access", "autonomous-dry-run", "managed-automation", "full-automation"] as const;
		for (const stage of stages.slice(0, -1)) rollout.advanceWithEvidence(stage, { passed: true, stage });
		rollout.recordEvidence("full-automation", { passed: true, stage: "full-automation" });
		expect(() => rollout.assertReleaseReady({ legacyRetained: false, rollbackWindowDays: 30 })).toThrow("legacy");
		expect(() => rollout.assertReleaseReady({ legacyRetained: true, rollbackWindowDays: 30 })).not.toThrow();
		const calls: string[] = [];
		const drill = await runRollbackDrill(Object.fromEntries(["switchReadsToLegacy", "rebuildFromGitCommit", "restorePostgres", "disableHostedWrites", "revokeTokens", "restoreRemoteBackup", "recoverLocalModel", "recoverPostgresOutage"].map((name) => [name, async () => { calls.push(name); }])), { legacyRetained: true, now: new Date("2026-01-01T00:00:00.000Z") });
		expect(drill).toMatchObject({ passed: true, legacyRetained: true, completedAt: "2026-01-01T00:00:00.000Z" });
		expect(calls).toHaveLength(8);
	});
});
