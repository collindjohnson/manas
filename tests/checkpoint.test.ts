import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildConversation } from "../src/adapters/common";
import { planArchiveChanges, scanArchive } from "../src/archive";

describe("source checkpoints", () => {
  test("does not rewrite a baseline body when its source timestamp has not advanced", async () => {
    const root = await mkdtemp(join(tmpdir(), "manas-checkpoint-"));
    await mkdir(join(root, "codex"), { recursive: true });
    const path = join(root, "codex", "baseline--ID.md");
    await Bun.write(path, [
      "---",
      'nessie_id: "ID"',
      'provider: "codex"',
      'source_id: "source"',
      'original_updated_at: "2026-01-01 00:00:00.000"',
      "---",
      "",
      "user: baseline\n",
    ].join("\n"));
    const conversation = buildConversation("codex", "source", "source.jsonl", { updatedAt: "2026-01-01T00:00:00.000Z" }, [{ role: "user", text: "normalized but different" }]);
    const changes = planArchiveChanges(await scanArchive(root), [conversation!], root);
    expect(changes[0]?.kind).toBe("skip");
    expect(await readFile(path, "utf8")).toContain("user: baseline");
  });
});
