import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultConfig } from "../src/config";
import { startLocalService, callLocalService } from "../src/local-service";
import { manageAgentHooks } from "../src/agent-hooks";
import { runAgentHook } from "../src/agent-hook-runtime";
import { readHookObservations } from "../src/agent-hook-observations";
import { verificationInstallationId } from "../src/agent-verification-state";
if (!process.argv.includes("--run-native")) throw new Error("Usage: bun run scripts/verify-native-claude-capture.ts --run-native [--report path]");
const run = promisify(execFile), model = "qwen3.8:27b";
const response = await fetch("http://127.0.0.1:11434/api/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
const descriptor = await response.json() as { remote_model?: string; remote_host?: string };
if (!response.ok || descriptor.remote_model || descriptor.remote_host) throw new Error("Installed local qwen3.8:27b is required.");
const root = await mkdtemp(join(tmpdir(), "manas-native-claude-capture-"));
const config = { ...defaultConfig({}), stateRoot: join(root, "state"), archiveRoot: join(root, "archive"), providers: { generation: { endpoint: "http://127.0.0.1:11434/v1/chat/completions", model, privacy: "local" as const } } };
const configPath = join(root, "config.json"), home = join(root, "installation"), cwd = join(root, "workspace");
await mkdir(cwd); await writeFile(configPath, JSON.stringify(config));
const options = { agent: "claude-code" as const, home, stateRoot: config.stateRoot, configPath, executable: [process.execPath, resolve("src/cli.ts")], capture: true };
const installationId = verificationInstallationId(options), sessionId = randomUUID();
const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store") });
const fact = "My preferred text editor is Helix.";
async function memories() { return (await callLocalService(config, "memory.recall", { query: "editor" }, { context: { scope: "read", allowedAccessLabels: ["personal"] } }) as { results: Array<{ id: string; text: string }> }).results.filter((entry) => entry.text === fact); }
async function settled() {
 let jobs: Array<{ type: string; status: string }> = [];
 for (let attempt = 0; attempt < 90; attempt++) {
  jobs = await callLocalService(config, "jobs.list") as typeof jobs;
  if (jobs.some((job) => job.type === "memory-capture") && jobs.every((job) => ["complete", "failed", "cancelled"].includes(job.status))) return jobs;
  await new Promise((done) => setTimeout(done, 1000));
 }
 return jobs;
}
try {
 await run("git", ["-C", service.engine.repository.root, "config", "user.name", "Native capture fixture"]);
 await run("git", ["-C", service.engine.repository.root, "config", "user.email", "fixture@example.invalid"]);
 const installed = await manageAgentHooks(options, "install");
 const started = performance.now();
 const pending = run("claude", ["-p", "--model", model, "--session-id", sessionId, "--setting-sources", "", "--settings", installed.path, "--tools", "", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--output-format", "json", "--max-turns", "2", "--system-prompt", "Acknowledge the user preference in one short sentence. Do not call tools or delegate.", fact], { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_BASE_URL: "http://127.0.0.1:11434", ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, timeout: 180000, maxBuffer: 4194304 });
 pending.child.stdin?.end();
 const native = JSON.parse((await pending).stdout);
 const jobs = await settled();
 const observations = await readHookObservations(config.stateRoot, installationId);
 const turns = await service.engine.store!.query<{ session_id: string; turn_id: string; prompt: string }>("SELECT session_id,turn_id,prompt FROM brain_capture_turns WHERE installation_id=$1", [installationId]);
 const first = await memories();
 const queued = observations.some((entry) => entry.event === "Stop" && entry.outcome === "queued");
 const captured = !native.is_error && native.session_id === sessionId && queued && jobs.every((job) => job.status === "complete") && first.length === 1 && turns.length === 1 && turns[0]!.session_id === sessionId && Boolean(turns[0]!.turn_id) && turns[0]!.prompt === fact;
 if (!captured) console.error(JSON.stringify({ diagnostic: "Synthetic native Claude Stop", subtype: native.subtype, jobs, observations, stagedTurns: turns.length, memories: first.length }));
 const checks: Record<string, unknown>[] = [{ name: "native-stop-background-capture", passed: captured, queued, stableNativeIdentity: turns.length === 1 && turns[0]!.session_id === sessionId && Boolean(turns[0]!.turn_id), memories: first.length, latencyMs: Math.round(performance.now() - started) }];
 if (captured) {
  const directory = join(home, ".claude", "projects");
  const files = (await readdir(directory, { recursive: true })).filter((file) => file.endsWith(sessionId + ".jsonl"));
  if (files.length !== 1) throw new Error("Native transcript identity is ambiguous.");
  await runAgentHook(config, "claude-code", { hook_event_name: "Stop", session_id: sessionId, transcript_path: join(directory, files[0]!) }, installationId);
  const repeated = await settled(), after = await memories();
  checks.push({ name: "redelivered-stop-deduplicates-native-transcript", passed: after.length === 1 && after[0]!.id === first[0]!.id && repeated.filter((job) => job.type === "memory-capture").length === 1 && repeated.every((job) => job.status === "complete"), memories: after.length });
 }
 if (captured && process.argv.includes("--verify-installation")) {
  const pending = run(process.execPath, [resolve("src/cli.ts"), "--config", configPath, "agents", "verify", "claude-code", "--home", home, "--query", "editor"], { env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_MODEL: model, ANTHROPIC_BASE_URL: "http://127.0.0.1:11434", ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, timeout: 150000, maxBuffer: 4194304 });
  pending.child.stdin?.end();
  const result = JSON.parse((await pending).stdout);
  const status = await manageAgentHooks(options, "status");
  checks.push({ name: "native-installed-verification-command", passed: result.ok === true && result.data?.integrationObserved === true && status.integrationObserved === true && status.hookTrust === "observed-at-verification", trustBypass: false });
 }
 const report = { version: 1, createdAt: new Date().toISOString(), agent: "claude-code", nativeVersion: (await run("claude", ["--version"])).stdout.trim(), isolated: true, persistentConfigurationChanged: false, inference: { mode: "local-ollama", model, fallback: false }, checks, passed: captured && checks.every((check) => check.passed), limitations: "Real native Stop and transcript capture using a disposable CLAUDE_CONFIG_DIR and local model. Duplicate-delivery check replays Stop against that actual transcript. Does not verify subscription authentication or visible desktop UI." };
 const index = process.argv.indexOf("--report");
 if (index >= 0) { if (!process.argv[index + 1]) throw new Error("--report requires a path"); await writeFile(resolve(process.argv[index + 1]), JSON.stringify(report, null, 2) + "\n"); }
 console.log(JSON.stringify(report, null, 2));
 if (!report.passed) throw new Error("Native Claude Stop verification did not pass.");
} finally { await manageAgentHooks(options, "uninstall").catch(() => {}); await service.close(); await rm(root, { recursive: true, force: true }); }
