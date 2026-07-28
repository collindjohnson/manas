import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { discoverClaudeCode } from "../src/adapters/claude-code";
import { discoverCodex } from "../src/adapters/codex";
import { discoverPi } from "../src/adapters/pi";
import { discoverGrok } from "../src/adapters/grok";
import { discoverCursor } from "../src/adapters/cursor";
import { parseChatgptExport, parseClaudeExport } from "../src/imports/exports";
import { readZip } from "../src/imports/zip";

async function fixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "manas-test-"));
}

function storedZip(name: string, content: string): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const data = encoder.encode(content);
  const out = new Uint8Array(30 + nameBytes.length + data.length + 46 + nameBytes.length + 22);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint32(offset, 0x04034b50, true); view.setUint16(offset + 8, 0, true); view.setUint16(offset + 10, 0, true);
  view.setUint32(offset + 18, data.length, true); view.setUint32(offset + 22, data.length, true); view.setUint16(offset + 26, nameBytes.length, true);
  out.set(nameBytes, offset + 30); out.set(data, offset + 30 + nameBytes.length); offset += 30 + nameBytes.length + data.length;
  view.setUint32(offset, 0x02014b50, true); view.setUint16(offset + 8, 0, true); view.setUint16(offset + 10, 0, true);
  view.setUint32(offset + 20, data.length, true); view.setUint32(offset + 24, data.length, true); view.setUint16(offset + 28, nameBytes.length, true); view.setUint32(offset + 42, 0, true);
  out.set(nameBytes, offset + 46); offset += 46 + nameBytes.length;
  view.setUint32(offset, 0x06054b50, true); view.setUint16(offset + 8, 1, true); view.setUint16(offset + 10, 1, true); view.setUint32(offset + 12, 46 + nameBytes.length, true); view.setUint32(offset + 16, 30 + nameBytes.length + data.length, true);
  return out;
}

describe("local adapters", () => {
  test("parses Claude Code user-facing messages and ignores system/tool records", async () => {
    const root = await fixtureDir();
    const path = join(root, "project", "session.jsonl");
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(path, [
      JSON.stringify({ type: "system", sessionId: "claude-1", cwd: "/tmp/my-project", timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ type: "assistant", sessionId: "claude-1", message: { role: "assistant", content: [{ type: "tool_use", input: "ignore" }, { type: "text", text: "Answer" }] }, timestamp: "2026-01-01T00:02:00Z" }),
      JSON.stringify({ type: "user", sessionId: "claude-1", message: { role: "user", content: "Question" }, timestamp: "2026-01-01T00:01:00Z" }),
      JSON.stringify({ type: "system", subtype: "done" }),
    ].join("\n") + "\n");
    const result = await discoverClaudeCode(root);
    expect(result.failures).toHaveLength(0);
    expect(result.conversations[0]?.sourceId).toBe("claude-1");
    expect(result.conversations[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.conversations[0]?.messages[0]?.text).toBe("Question");
    expect(result.conversations[0]?.project).toBe("my-project");
  });

  test("parses Codex wrappers, filters developer records, and retries trailing JSON", async () => {
    const root = await fixtureDir();
    await mkdir(join(root, "sessions"), { recursive: true });
    const path = join(root, "sessions", "one.jsonl");
    await writeFile(path, [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-1", cwd: "/tmp/codex-project" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "ignore" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Hi" }, timestamp: 1767225600 }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "ignore" }, timestamp: 1767225650 }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Hello" }, timestamp: 1767225660 }),
      "{\"type\":\"event_msg\"",
    ].join("\n"));
    const result = await discoverCodex(root);
    expect(result.failures).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.conversations[0]?.messages.map((message) => message.text)).toEqual(["Hi", "Hello"]);
  });

  test("parses Pi short conversations and excludes thinking/tool blocks", async () => {
    const root = await fixtureDir();
    const path = join(root, "pi.jsonl");
    await writeFile(path, [
      JSON.stringify({ type: "session", id: "pi-1", cwd: "/tmp/pi-project", timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: [{ type: "text", text: "x" }] } }),
      JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:03Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "read" }, { type: "text", text: "y" }] } }),
    ].join("\n") + "\n");
    const result = await discoverPi(root);
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]?.messages.map((message) => message.text)).toEqual(["x", "y"]);
  });

  test("reconstructs Grok chunks in authoritative update order", async () => {
    const root = await fixtureDir();
    const session = join(root, "session-1");
    await mkdir(session, { recursive: true });
    await writeFile(join(session, "summary.json"), JSON.stringify({ info: { id: "grok-1", cwd: "/tmp/grok-project", generated_title: "Grok title", created_at: "2026-01-01T00:00:00Z" } }));
    await writeFile(join(session, "updates.jsonl"), [
      JSON.stringify({ timestamp: 1767225600, params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Ask" } } } }),
      JSON.stringify({ timestamp: 1767225601, params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hidden" } } } }),
      JSON.stringify({ timestamp: 1767225602, params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reply" } } } }),
    ].join("\n") + "\n");
    const result = await discoverGrok(root);
    expect(result.failures).toHaveLength(0);
    expect(result.conversations[0]?.title).toBe("Grok title");
    expect(result.conversations[0]?.messages.map((message) => message.text)).toEqual(["Ask", "Reply"]);
  });

  test("reads both Cursor SQLite table names without modifying the databases", async () => {
    const root = await fixtureDir();
    const global = join(root, "global", "state.vscdb");
    const workspace = join(root, "workspace", "state.vscdb");
    for (const [path, table] of [[global, "cursorDiskKV"], [workspace, "ItemTable"]] as const) {
      await mkdir(join(path, ".."), { recursive: true });
      const database = new Database(path);
      database.run(`CREATE TABLE ${table} (key TEXT PRIMARY KEY, value BLOB)`);
      database.run(`INSERT INTO ${table} (key, value) VALUES (?, ?)`, ["composerData:cursor-1", JSON.stringify({ conversationId: "cursor-1", title: "Cursor", messages: [{ role: "user", content: "A" }, { role: "assistant", content: "B" }] })]);
      database.close();
    }
    const result = await discoverCursor(root);
    expect(result.failures).toHaveLength(0);
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]?.messages.map((message) => message.text)).toEqual(["A", "B"]);
  });
});

describe("official exports", () => {
  test("follows ChatGPT active branch and filters system/tool nodes", () => {
    const result = parseChatgptExport({ conversations: [{ id: "chat-1", title: "Chat", current_node: "a2", mapping: {
      root: { id: "root", message: { author: { role: "system" }, content: { parts: ["ignore"] } } },
      a1: { id: "a1", parent: "root", message: { author: { role: "user" }, create_time: 2, content: { parts: ["Short"] } } },
      a2: { id: "a2", parent: "a1", message: { author: { role: "assistant" }, create_time: 1, content: { parts: ["Answer"] } } },
      side: { id: "side", parent: "root", message: { author: { role: "user" }, content: { parts: ["not active"] } } },
    } }] });
    expect(result).toHaveLength(1);
    expect(result[0]?.messages.map((message) => message.text)).toEqual(["Answer", "Short"]);
  });

  test("parses Claude ordered chat messages", () => {
    const result = parseClaudeExport([{ uuid: "claude-web-1", name: "Claude web", chat_messages: [
      { sender: "human", text: "Hi" }, { sender: "assistant", content: [{ type: "text", text: "Hello" }] }, { sender: "tool", text: "ignore" },
    ] }]);
    expect(result[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("rejects ZIP traversal", async () => {
    const root = await fixtureDir();
    const path = join(root, "bad.zip");
    await writeFile(path, storedZip("../escape.json", "{}"));
    await expect(readZip(path)).rejects.toThrow("escapes extraction root");
  });
});
