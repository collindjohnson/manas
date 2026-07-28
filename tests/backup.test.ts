import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositoryBackup, inventoryBackup, verifyRepositoryBackup } from "../src/brain/backup";

describe("repository backup verification", () => {
	test("copies and verifies a byte-preserving inventory", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-backup-"));
		try {
			const source = join(root, "source");
			const backup = join(root, "backup");
			await mkdir(join(source, "nested"), { recursive: true });
			await writeFile(join(source, "nested", "page.md"), "# page\n");
			const report = await createRepositoryBackup(source, backup);
			expect(report.entries).toHaveLength(1);
			expect(await verifyRepositoryBackup(source, backup)).toEqual({ valid: true, missing: [], changed: [], extra: [] });
			await writeFile(join(backup, "nested", "page.md"), "changed\n");
			expect(await verifyRepositoryBackup(source, backup)).toMatchObject({ valid: false, changed: ["nested/page.md"] });
			expect((await inventoryBackup(source)).bytes).toBe(7);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test("refuses symlinked content", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-backup-"));
		try {
			const source = join(root, "source");
			await mkdir(source);
			await symlink("/tmp", join(source, "escape"));
			await expect(inventoryBackup(source)).rejects.toThrow("symlink");
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
