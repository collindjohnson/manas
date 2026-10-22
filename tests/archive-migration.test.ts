import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyArchiveMigration, previewArchiveMigration, readArchiveMigration } from "../src/archive-migration";
import { BrainRepository } from "../src/brain/repository";

test("migration resumes interrupted copies and a committed receipt gap without rewriting IDs or transcripts", async () => {
	const root = await mkdtemp(join(tmpdir(), "manas-migrate-resume-"));
	try {
		const legacy = join(root, "archive"), target = join(root, "brain"), state = join(root, "state");
		const transcript = "---\nmanas_id: KEEP\ncreated_at: 2024-01-01T00:00:00Z\n---\n\nEdited user transcript.\n";
		await Bun.write(join(legacy, "codex", "chat.md"), transcript);
		await Bun.write(join(legacy, "notes", "plain.md"), "An ordinary unassigned note.");
		await Bun.write(join(legacy, "attachment.bin"), new Uint8Array([0, 255, 1, 2]));
		const preview = await previewArchiveMigration(legacy, target, state);
		expect(preview.status).toBe("planned");
		expect(await Bun.file(join(target, "codex", "chat.md")).exists()).toBe(false);
		await expect(applyArchiveMigration(state, preview.id, { fault: (point) => { if (point === "copied") throw new Error("copy crash"); } })).rejects.toThrow("copy crash");
		await utimes(join(target, preview.files[0]!.path), 1, 1);
		await expect(applyArchiveMigration(state, preview.id, { fault: (point) => { if (point === "committed") throw new Error("receipt crash"); } })).rejects.toThrow("receipt crash");
		const result = await applyArchiveMigration(state, preview.id);
		expect(result).toMatchObject({ status: "verified", files: preview.files });
		expect(await readFile(join(target, "codex", "chat.md"), "utf8")).toBe(transcript);
		expect(await readFile(join(legacy, "codex", "chat.md"), "utf8")).toBe(transcript);
		expect([...await readFile(join(target, "attachment.bin"))]).toEqual([0, 255, 1, 2]);
		expect(Math.abs((await stat(join(target, preview.files[0]!.path))).mtimeMs - preview.files[0]!.mtimeMs)).toBeLessThan(1);
		const snapshot = await new BrainRepository(target).snapshot();
		expect(snapshot.pages.map((page) => page.id).sort()).toEqual(preview.files.filter((file) => file.id).map((file) => file.id!).sort());
		expect((await applyArchiveMigration(state, preview.id)).commit).toBe(result.commit);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("migration stops on source changes and preserves target edits after interruption", async () => {
	const root = await mkdtemp(join(tmpdir(), "manas-migrate-collision-"));
	try {
		const legacy = join(root, "archive"), target = join(root, "brain"), state = join(root, "state");
		await Bun.write(join(legacy, "note.md"), "original");
		const receipt = await previewArchiveMigration(legacy, target, state);
		await expect(applyArchiveMigration(state, receipt.id, { fault: () => { throw new Error("crash"); } })).rejects.toThrow("crash");
		await writeFile(join(target, "note.md"), "user edits");
		await expect(applyArchiveMigration(state, receipt.id)).rejects.toThrow("retained target edits");
		expect(await readFile(join(target, "note.md"), "utf8")).toBe("user edits");
		await writeFile(join(legacy, "note.md"), "new upstream bytes");
		await expect(applyArchiveMigration(state, receipt.id)).rejects.toThrow("archive changed");
		expect((await readArchiveMigration(state, receipt.id)).status).toBe("copying");
	} finally { await rm(root, { recursive: true, force: true }); }
});


test("migration preserves exact bytes under Git line-ending attributes", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-migrate-git-bytes-"));
 try {
  const source = join(root, "archive"), target = join(root, "brain"), state = join(root, "state");
  await Bun.write(join(source, ".gitattributes"), "*.md text eol=lf\n");
  const original = "Original CRLF transcript.\r\nOwner edits retained.\r\n";
  await Bun.write(join(source, "note.md"), original);
  await Bun.write(join(source, "literal[1] café.md"), original);
  await Bun.write(join(source, ".gitignore"), "*.md\n");
  const receipt = await previewArchiveMigration(source, target, state);
  const completed = await applyArchiveMigration(state, receipt.id);
  expect(completed.status).toBe("verified");
  expect((await new BrainRepository(target).verify()).valid).toBe(true);
  expect(await readFile(join(source, "note.md"), "utf8")).toBe(original);
  expect(await readFile(join(target, "note.md"), "utf8")).toBe(original);
 } finally { await rm(root, { recursive: true, force: true }); }
});
