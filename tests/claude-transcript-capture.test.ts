import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, appendFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createBrainEngine, type BrainEngine } from "../src/engine";
import { defaultConfig } from "../src/config";
import { manageAgentHooks } from "../src/agent-hooks";
import { enqueueClaudeTranscript } from "../src/brain/claude-transcript-capture";
import { recall } from "../src/brain/memory";
import { listJobs } from "../src/brain/jobs";
async function fixture(work: (value: { engine: BrainEngine; id: string; path: string; root: string; configure: (capture: boolean) => Promise<unknown>; calls: () => number }) => Promise<void>) {
 const root = await mkdtemp(join(tmpdir(), "manas-claude-capture-"));
 const config = { ...defaultConfig({}), stateRoot: join(root, "state") };
 const home = join(root, "home"), path = join(home, ".claude", "projects", "project", "session.jsonl");
 const id = createHash("sha256").update("claude-code:" + home).digest("hex");
 let engine: BrainEngine | undefined, calls = 0;
 try {
  await mkdir(join(path, ".."), { recursive: true });
  engine = await createBrainEngine({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), providers: { generation: { id: "fixture", generate: async (input) => {
   calls++;
   const prompt = JSON.parse(input.slice(input.lastIndexOf("Source: ") + 8)) as string;
   return JSON.stringify({ spans: [{ start: 0, end: prompt.length }] });
  } } } });
  const run = promisify(execFile);
  await run("git", ["-C", engine.repository.root, "config", "user.name", "Test"]);
  await run("git", ["-C", engine.repository.root, "config", "user.email", "test@example.invalid"]);
  const configure = (capture: boolean) => manageAgentHooks({ agent: "claude-code", home, stateRoot: config.stateRoot, configPath: join(root, "config.json"), executable: [process.execPath, "cli.ts"], capture }, "install");
  await configure(true);
  await work({ engine, id, path, root, configure, calls: () => calls });
 } finally { await engine?.close(); await rm(root, { recursive: true, force: true }); }
}
const owner = { scope: "admin" as const, tenantId: "local" };
const user = (uuid: string, text: string, timestamp = new Date(Date.now() + 100).toISOString()) => ({ type: "user", sessionId: "session", uuid, timestamp, message: { role: "user", content: text } });
async function drain(engine: BrainEngine) {
 for (let iteration = 0; iteration < 100; iteration++) {
  const result = await engine.operations.execute(owner, "jobs.run-one", {}) as { job: unknown };
  if (!result.job) return;
 }
 throw new Error("fixture exceeded job budget");
}
test("Claude capture reconciles stable UUIDs, late records, and incomplete tails without generated text", async () => fixture(async ({ engine, id, path, calls }) => {
 const records = [
  user("old", "Historical fact before opt-in.", "2000-01-01T00:00:00.000Z"),
  { type: "assistant", uuid: "assistant", message: { role: "assistant", content: "Generated fact must not be captured." } },
  { ...user("meta", "Synthetic summary."), isMeta: true },
  { ...user("tool", ""), message: { role: "user", content: [{ type: "tool_result", content: "Generated tool result" }, { type: "text", text: "Synthetic tool annotation" }] } },
  user("turn-1", "Juniper owner is Maya."),
 ];
 await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
 const input = { installationId: id, sessionId: "session", transcriptPath: path };
 const brainId = (await engine.repository.getIdentity()).brainId;
 const queued = await enqueueClaudeTranscript(engine.store!, engine.config.stateRoot, input, brainId);
 expect(await enqueueClaudeTranscript(engine.store!, engine.config.stateRoot, input, brainId)).toEqual(queued);
 expect(calls()).toBe(0);
 await drain(engine);
 expect(calls()).toBe(1);
 let memories = await recall(engine.repository, owner, { query: "Juniper" });
 expect(memories.results.map((memory) => memory.text)).toEqual(["Juniper owner is Maya."]);
 expect(memories.results[0].provenance).toMatchObject({ sourceType: "claude-code-capture", sessionId: "session", turnId: "turn-1" });
 const partial = JSON.stringify(user("turn-3", "Juniper milestone is Friday."));
 await appendFile(path, JSON.stringify(user("turn-2", "Juniper reviewer is Lee.")) + "\n" + partial.slice(0, -5));
 await enqueueClaudeTranscript(engine.store!, engine.config.stateRoot, input, brainId);
 await drain(engine);
 expect(calls()).toBe(2);
 await appendFile(path, partial.slice(-5) + "\n");
 await enqueueClaudeTranscript(engine.store!, engine.config.stateRoot, input, brainId);
 await drain(engine);
 memories = await recall(engine.repository, owner, { query: "Juniper" });
 expect(memories.results).toHaveLength(3);
 expect(calls()).toBe(3);
 expect((await recall(engine.repository, { ...owner, allowedAccessLabels: [] }, { query: "Juniper" })).results).toEqual([]);
}));
test("Claude transcript boundary and capture grant are checked before deferred reads", async () => fixture(async ({ engine, id, path, root, configure, calls }) => {
 const initialHead = await engine.repository.head();
 const outside = join(root, "outside.jsonl");
 await writeFile(outside, JSON.stringify(user("outside", "Outside source.")) + "\n");
 const brainId = (await engine.repository.getIdentity()).brainId;
 const input = { installationId: id, sessionId: "session", transcriptPath: outside };
 await expect(enqueueClaudeTranscript(engine.store!, engine.config.stateRoot, input, brainId)).rejects.toThrow("outside");
 await symlink(outside, path);
 await expect(enqueueClaudeTranscript(engine.store!, engine.config.stateRoot, { ...input, transcriptPath: path }, brainId)).rejects.toThrow();
 await rm(path);
 await writeFile(path, JSON.stringify(user("turn", "Juniper owner is Maya.")) + "\n");
 await enqueueClaudeTranscript(engine.store!, engine.config.stateRoot, { ...input, transcriptPath: path }, brainId);
 await configure(false);
 await configure(true);
 await expect(engine.operations.execute(owner, "jobs.run-one", {})).rejects.toThrow("grant");
 expect(calls()).toBe(0);
 expect((await listJobs(engine.store!))[0]).toMatchObject({ status: "pending" });
 expect(await engine.repository.head()).toBe(initialHead);
}));
test("Claude transcript pages checkpoint only after persistence and resume from a saved byte boundary", async () => fixture(async ({ engine, id, path, calls }) => {
 const padding = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "x".repeat(600000) } });
 await writeFile(path, padding + "\n" + JSON.stringify(user("last", "Juniper owner is Maya.")) + "\n");
 const input = { installationId: id, sessionId: "session", transcriptPath: path };
 await enqueueClaudeTranscript(engine.store!, engine.config.stateRoot, input, (await engine.repository.getIdentity()).brainId);
 await engine.operations.execute(owner, "jobs.run-one", {});
 const jobs = await listJobs(engine.store!);
 expect(jobs.some((job) => job.status === "pending" && job.type === "claude-transcript-capture")).toBe(true);
 expect(calls()).toBe(0);
 await drain(engine);
 expect(calls()).toBe(1);
 expect((await recall(engine.repository, owner, { query: "Juniper" })).results).toHaveLength(1);
}));
