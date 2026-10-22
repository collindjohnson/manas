import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { applyArchiveMigration, previewArchiveMigration } from "../src/archive-migration";
import { activateCanonicalArchive, loadCanonicalSelection, rollbackCanonicalArchive, shadowArchiveMigration } from "../src/canonical-runtime";
import { acquireStoreOwnership } from "../src/brain/ownership";

test("canonical cutover requires shadow review, exclusive ownership, and preserves rollback archives", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-cutover-"));
 try {
  const config = { ...defaultConfig({}), archiveRoot: join(root, "archive"), stateRoot: join(root, "state") };
  await Bun.write(join(config.archiveRoot, "note.md"), "---\nmanas_id: stable-note\n---\n\nMigration telescope evidence.");
  const preview = await previewArchiveMigration(config.archiveRoot, join(root, "brain"), config.stateRoot);
  const receipt = await applyArchiveMigration(config.stateRoot, preview.id);
  await expect(activateCanonicalArchive(config, receipt.id, receipt.commit!)).rejects.toThrow();
  const shadow = await shadowArchiveMigration(config, receipt.id, ["telescope"]);
  expect(shadow.queries[0]?.canonicalIds).toEqual(["stable-note"]);
  const release = await acquireStoreOwnership(join(config.stateRoot, "service"));
  try { await expect(activateCanonicalArchive(config, receipt.id, receipt.commit!, true)).rejects.toThrow(); }
  finally { release(); }
  expect((await activateCanonicalArchive(config, receipt.id, receipt.commit!, true)).mode).toBe("canonical");
  expect((await loadCanonicalSelection(config))?.baseCommit).toBe(receipt.commit);
  expect((await rollbackCanonicalArchive(config)).mode).toBe("legacy");
  expect(await Bun.file(join(config.archiveRoot, "note.md")).exists()).toBe(true);
  expect(await Bun.file(join(root, "brain", "note.md")).exists()).toBe(true);
 } finally { await rm(root, { recursive: true, force: true }); }
});
