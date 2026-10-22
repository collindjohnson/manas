import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { defaultConfig } from "../src/config";
import { startLocalService, callLocalService } from "../src/local-service";
import { manageAgentMcp, agentClientId } from "../src/agent-mcp";
import { manageAgentHooks } from "../src/agent-hooks";
import { readHookObservations } from "../src/agent-hook-observations";
import type { ContextDelivery } from "../src/brain/context-delivery";

if (!process.argv.includes("--run-native")) throw new Error("Usage: bun run scripts/verify-native-codex.ts --run-native [--run-native-hooks] [--run-native-capture] [--report <path>]");
const verifyCapture = process.argv.includes("--run-native-capture");
const verifyHooks = process.argv.includes("--run-native-hooks");
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "manas-native-codex-"));
const config = { ...defaultConfig({}), stateRoot: join(root, "state"), archiveRoot: join(root, "archive"), ...(verifyCapture ? { providers: { generation: { endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "qwen3.8:27b", privacy: "local" as const } } } : {}) };
const configPath = join(root, "config.json"), cwd = join(root, "workspace");
await mkdir(cwd); await writeFile(configPath, JSON.stringify(config));
const options = { agent: "codex" as const, home: join(root, "installation"), stateRoot: config.stateRoot, configPath, executable: [process.execPath, resolve("src/cli.ts")], write: true };
const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), worker: verifyCapture });
function toml(value: unknown): string {
 if (Array.isArray(value)) return "[" + value.map(toml).join(", ") + "]";
 if (value && typeof value === "object") return "{ " + Object.entries(value).map(([key, child]) => JSON.stringify(key) + " = " + toml(child)).join(", ") + " }";
 if (value === null || value === undefined) throw new Error("Null TOML value");
 return JSON.stringify(value);
}
// Fail closed if inherited user hooks differ from the exact scripts reviewed for this smoke test.
async function vetInheritedHooks() {
 const source = join(homedir(), ".codex", "hooks.json");
 let text: string;
 try { text = await readFile(source, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
 const configuration = JSON.parse(text);
 const reviewed = new Map([
  ["python3 ~/.codex/hooks/protect_paths.py", { path: join(homedir(), ".codex", "hooks", "protect_paths.py"), hash: "3c10ef1b0bdd1dd47fc1e8b938fe650ad9bbbf9dd434c96a6903776908e892a2" }],
  ["bash " + String.fromCharCode(39) + join(homedir(), ".codex", "herdr-agent-state.sh") + String.fromCharCode(39) + " session", { path: join(homedir(), ".codex", "herdr-agent-state.sh"), hash: "2ac8115359ff849cd61e450574b371f6732780a63a07ad87c00448db5c20362d" }],
 ]);
 const hashes = [];
 for (const groups of Object.values(configuration.hooks ?? {}) as any[]) for (const group of groups) for (const hook of group.hooks ?? []) {
  const entry = reviewed.get(hook.command);
  if (hook.type !== "command" || !entry || createHash("sha256").update(await readFile(entry.path)).digest("hex") !== entry.hash) throw new Error("An inherited hook has not been reviewed; run the MCP-only check or review it before using the one-run hook override.");
  hashes.push(entry.hash);
 }
 return hashes.sort();
}
async function native(args: string[]) {
 const pending = run("codex", ["exec", "--ignore-user-config", "--ephemeral", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", cwd, ...args], { cwd, env: { ...process.env, HERDR_ENV: "0" }, timeout: 180_000, maxBuffer: 8_388_608 }); pending.child.stdin?.end();
 const output = await pending;
 return { events: output.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)), stderr: output.stderr };
}
const checks: Record<string, unknown>[] = [];
let inheritedHookHashes: string[] = [];
try {
 await run("git", ["-C", service.engine.repository.root, "config", "user.name", "Native integration fixture"]);
 await run("git", ["-C", service.engine.repository.root, "config", "user.email", "fixture@example.invalid"]);
 if (verifyHooks) {
  inheritedHookHashes = await vetInheritedHooks();
  const owner = "Mara-" + randomUUID(), forbidden = "forbidden-" + randomUUID();
  const seed = await callLocalService(config, "memory.remember", { text: "The Juniper release owner is " + owner + ".", provenance: { sourceType: "synthetic-native-fixture" }, idempotencyKey: "seed" }) as { id: string };
  await callLocalService(config, "memory.remember", { text: "The Juniper secret is " + forbidden + ".", visibility: ["private"], provenance: { sourceType: "synthetic-native-fixture" }, idempotencyKey: "secret" });
  const expected = (await callLocalService(config, "context.deliver", { query: "Juniper" }, { context: { scope: "read", allowedAccessLabels: [] } }) as ContextDelivery).citations.find((citation) => citation.documentId === seed.id);
  if (!expected) throw new Error("Fixture context is unavailable");
  const installed = await manageAgentHooks(options, "install");
  const hooks = JSON.parse(await readFile(installed.path, "utf8")).hooks;
  const schemaPath = join(root, "answer-schema.json");
  await writeFile(schemaPath, JSON.stringify({ type: "object", additionalProperties: false, required: ["answer", "citations"], properties: { answer: { type: "string" }, citations: { type: "array", items: { type: "object", additionalProperties: false, required: ["documentId", "revision", "commit", "startOffset", "endOffset"], properties: { documentId: { type: "string" }, revision: { type: "string" }, commit: { type: "string" }, startOffset: { type: "integer" }, endOffset: { type: "integer" } } } } } }));
  const instructions = "Synthetic Manas integration test. Answer the user query using only Manas evidence supplied by hooks. Do not call tools, read files, or delegate. Return JSON with answer and citations, copying documentId, revision, commit, startOffset, endOffset exactly from the evidence. If no evidence arrived return NO_CONTEXT with empty citations.";
  const started = performance.now();
  const output = await native(["--dangerously-bypass-hook-trust", "--output-schema", schemaPath, "-c", "mcp_servers={}", "-c", "hooks=" + toml(hooks), "-c", "developer_instructions=" + JSON.stringify(instructions), "Juniper"]);
  let answer: any;
  for (const event of output.events) if (event.type === "item.completed" && event.item?.type === "agent_message") { try { answer = JSON.parse(event.item.text); } catch {} }
  const observations = await readHookObservations(config.stateRoot, agentClientId(options.agent, options.home));
  const delivered = observations.some((value) => value.event === "UserPromptSubmit" && value.outcome === "delivered");
  const sessionId = output.events.find((event) => event.type === "thread.started")?.thread_id;
  const matchingSession = typeof sessionId === "string" && observations.some((value) => value.event === "UserPromptSubmit" && value.outcome === "delivered" && value.sessionHash === createHash("sha256").update(sessionId).digest("hex"));
  const cited = answer?.citations?.some((citation: any) => ["documentId", "revision", "commit", "startOffset", "endOffset"].every((key) => citation[key] === expected[key as keyof typeof expected]));
  const noToolCalls = !output.events.some((event) => event.item && ["mcp_tool_call", "command_execution", "web_search"].includes(event.item.type));
  const passed = delivered && matchingSession && cited && noToolCalls && answer?.answer?.includes(owner) && !JSON.stringify(answer).includes(forbidden) && JSON.stringify(inheritedHookHashes) === JSON.stringify(await vetInheritedHooks());
  checks.push({ name: "prompt-hook-cited-context", passed: Boolean(passed), delivered, matchingSession, exactCitation: Boolean(cited), noToolCalls, excludedPrivateEvidence: !JSON.stringify(answer ?? {}).includes(forbidden), latencyMs: Math.round(performance.now() - started) });
  if (!passed) console.error(JSON.stringify({ diagnostic: "Synthetic native hook context", events: output.events, observations, stderr: output.stderr }));
 }
 if (verifyCapture) {
  inheritedHookHashes = await vetInheritedHooks();
  const installed = await manageAgentHooks({ ...options, capture: true }, "install");
  const hooks = JSON.parse(await readFile(installed.path, "utf8")).hooks;
  const fact = "My preferred text editor is Helix.";
  const started = performance.now();
  const output = await native(["--dangerously-bypass-hook-trust", "-c", "mcp_servers={}", "-c", "hooks=" + toml(hooks), "-c", "developer_instructions=" + JSON.stringify("Acknowledge the synthetic user statement briefly. Do not call tools or delegate."), fact]);
  let jobs: Array<{ type: string; status: string; error?: unknown }> = [];
  for (let attempt = 0; attempt < 60; attempt++) {
   jobs = await callLocalService(config, "jobs.list") as typeof jobs;
   if (jobs.some((job) => job.type === "memory-capture" && ["complete", "failed"].includes(job.status))) break;
   await new Promise((done) => setTimeout(done, 1000));
  }
  const observations = await readHookObservations(config.stateRoot, agentClientId(options.agent, options.home));
  const result = await callLocalService(config, "memory.recall", { query: "editor" }, { context: { scope: "read", allowedAccessLabels: ["personal"] } }) as { results: Array<{ text: string }> };
  const captured = result.results.filter((memory) => memory.text.includes(fact));
  const queued = observations.some((value) => value.event === "Stop" && value.outcome === "queued");
  const passed = queued && jobs.filter((job) => job.type === "memory-capture" && job.status === "complete").length === 1 && captured.length === 1;
  checks.push({ name: "native-stop-background-capture", passed, queued, memories: captured.length, latencyMs: Math.round(performance.now() - started) });
  if (!passed) console.error(JSON.stringify({ diagnostic: "Synthetic native Stop capture", jobs, observations, events: output.events, stderr: output.stderr }));
 }
 const mcp = await manageAgentMcp(options, "install");
 const server = { manas: { ...mcp.entry, enabled_tools: ["memory.remember", "memory.recall"], default_tools_approval_mode: "approve" } };
 const text = "The synthetic Cobalt reviewer is Vale-" + randomUUID() + ".";
 const input = { text, provenance: { sourceType: "user", sessionId: "native-codex", turnId: "explicit-capture" }, idempotencyKey: "native:explicit-capture" };
 const prompt = "Synthetic Manas MCP test. Use only the manas MCP tools; do not run shell commands, read files, or delegate. First call memory.remember with this exact input: " + JSON.stringify(input) + ". Repeat that identical call to verify idempotency. Then call memory.recall with query Cobalt. Reply with the memory ID and whether replay and recall succeeded.";
 const started = performance.now();
 const output = await native(["-c", "mcp_servers=" + toml(server), prompt]);
 const result = await callLocalService(config, "memory.recall", { query: "Cobalt" }) as { results: Array<{ id: string; text: string }> };
 const memories = result.results.filter((value) => value.text === text);
 const calls = output.events.filter((event) => event.type === "item.completed" && event.item?.type === "mcp_tool_call").map((event) => event.item);
 const payload = (call: any) => { try { return JSON.parse(call.result.content.find((entry: any) => entry.type === "text").text); } catch { return undefined; } };
 const writes = calls.filter((call) => call.server === "manas" && call.tool === "memory.remember" && call.status === "completed").map(payload);
 const recalls = calls.filter((call) => call.server === "manas" && call.tool === "memory.recall" && call.status === "completed").map(payload);
 const replayVerified = writes.length === 2 && writes[0]?.id === writes[1]?.id && writes[0]?.revision === writes[1]?.revision && writes[0]?.commit === writes[1]?.commit && writes[0]?.replayed === false && writes[1]?.replayed === true;
 const recallVerified = memories.length === 1 && recalls.some((value) => value?.results?.some((record: any) => record.id === memories[0]!.id && record.text === text));
 const passed = replayVerified && recallVerified && calls.length === 3 && calls.every((call) => call.status === "completed" && ["memory.remember", "memory.recall"].includes(call.tool));
 checks.push({ name: "authorized-mcp-capture-and-replay", passed, replayVerified, recallVerified, memories: memories.length, latencyMs: Math.round(performance.now() - started) });
 if (!passed) console.error(JSON.stringify({ diagnostic: "Synthetic native MCP events", events: output.events, stderr: output.stderr }));
 const report = { version: 1, createdAt: new Date().toISOString(), agent: "codex", nativeVersion: (await run("codex", ["--version"])).stdout.trim(), isolated: true, persistentConfigurationChanged: false, persistentHookTrustChanged: false, hookTrustMode: verifyHooks || verifyCapture ? "one-run-reviewed-source-override" : "unchanged", inheritedHookHashes, transientlyApprovedTools: ["memory.remember", "memory.recall"], checks, passed: checks.every((check) => check.passed), limitations: "Synthetic native exec sessions with transient configuration and existing account authentication. Hook verification uses the documented one-run trust override after source review; it does not establish persistent installation trust. Automatic Stop capture is checked only when --run-native-capture is selected." };
 const index = process.argv.indexOf("--report");
 if (index >= 0) { if (!process.argv[index + 1]) throw new Error("--report requires a path"); await writeFile(resolve(process.argv[index + 1]), JSON.stringify(report, null, 2) + "\n"); }
 console.log(JSON.stringify(report, null, 2));
 if (!report.passed) throw new Error("Native verification did not pass; inspect the report.");
} finally { await manageAgentMcp(options, "uninstall").catch(() => {}); await manageAgentHooks(options, "uninstall").catch(() => {}); await service.close(); await rm(root, { recursive: true, force: true }); }
