import { describe, expect, test } from "bun:test";
import { mkdir, readFile, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyArchiveChanges, planArchiveChanges, renderNewDocument, scanArchive } from "../src/archive";
import { buildConversation } from "../src/adapters/common";

async function rootDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "manas-archive-"));
}

describe("archive transactions", () => {
  test("bootstraps existing frontmatter, preserves ID/filename, and creates deterministic new documents", async () => {
    const root = await rootDir();
    const existingPath = join(root, "claude", "Existing title--KEEP.md");
    await mkdir(join(root, "claude"), { recursive: true });
    await Bun.write(existingPath, [
      "---",
      'manas_id: "KEEP"',
      'provider: "claude_code"',
      'source_id: "source-1"',
      'title: "Original title"',
      "---",
      "",
      "user: old\n",
    ].join("\n"));
    const scan = await scanArchive(root);
    const updated = buildConversation("claude_code", "source-1", "/tmp/source", {}, [{ role: "user", text: "new" }], "Renamed title");
    const created = buildConversation("claude_code", "source-2", "/tmp/source-2", {}, [{ role: "user", text: "short" }], "A/unsafe title");
    expect(updated).toBeDefined();
    expect(created).toBeDefined();
    const changes = planArchiveChanges(scan, [updated!, created!], root);
    expect(changes.map((change) => change.kind)).toEqual(["update", "create"]);
    expect(changes[0]?.relativePath).toBe("claude/Existing title--KEEP.md");
    await applyArchiveChanges(root, changes, false);
		expect(await readFile(existingPath, "utf8")).toContain('manas_id: "KEEP"');
		expect(await readFile(existingPath, "utf8")).toContain("user: new");
		expect(
			await readFile(join(root, changes[1]!.relativePath!), "utf8"),
		).toContain("manas_id:");
    const after = await scanArchive(root);
    expect(after.documents).toHaveLength(2);
		expect([...after.byManasId.keys()]).toContain(renderNewDocument(created!).id);
  });

  test("rolls back staged placement when one change fails path validation", async () => {
    const root = await rootDir();
    const good = { kind: "create" as const, provider: "pi" as const, sourceId: "good", relativePath: "pi/good.md", content: "good" };
    const bad = { kind: "create" as const, provider: "pi" as const, sourceId: "bad", relativePath: "../escape.md", content: "bad" };
    await expect(applyArchiveChanges(root, [good, bad], false)).rejects.toThrow("escapes root");
    await expect(stat(join(root, "pi", "good.md"))).rejects.toThrow();
  });

  test("dry run never writes changes", async () => {
    const root = await rootDir();
    const conversation = buildConversation("chatgpt", "chat-1", "export.json", {}, [{ role: "user", text: "Hi" }], "Hi");
    const changes = planArchiveChanges(await scanArchive(root), [conversation!], root);
    await applyArchiveChanges(root, changes, true);
    await expect(stat(join(root, "chatgpt"))).rejects.toThrow();
  });
});
