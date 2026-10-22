import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { defaultConfig } from "../src/config";
import { startLocalService, callLocalService } from "../src/local-service";
import { manageAgentHooks } from "../src/agent-hooks";
import { manageAgentMcp } from "../src/agent-mcp";
import type { ContextDelivery } from "../src/brain/context-delivery";
import { readHookObservations } from "../src/agent-hook-observations";

const agent = process.argv[2];
if (agent !== "claude-code" || !process.argv.includes("--run-native")) throw new Error("Usage: bun run scripts/verify-native-agent.ts claude-code --run-native [--local-model <installed-model>] [--report <path>]");
const localIndex = process.argv.indexOf("--local-model");
const localModel = localIndex >= 0 ? process.argv[localIndex + 1] : undefined;
if (localIndex >= 0 && (!localModel || localModel.startsWith("--") || /(?:[:\-])cloud$/i.test(localModel))) throw new Error("--local-model requires an installed local model.");
if (localModel) {
 const response = await fetch("http://127.0.0.1:11434/api/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: localModel }), signal: AbortSignal.timeout(5000) });
 const model = await response.json() as { remote_model?: string; remote_host?: string };
 if (!response.ok || model.remote_model || model.remote_host) throw new Error("The native smoke requires an installed local Ollama model.");
}
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "manas-native-agent-"));
const config = { ...defaultConfig({}), stateRoot: join(root, "state"), archiveRoot: join(root, "archive") };
const configPath = join(root, "config.json");
const home = join(root, "installation");
const cwd = join(root, "workspace");
await mkdir(cwd);
await writeFile(configPath, JSON.stringify(config));
const executable = [process.execPath, resolve("src/cli.ts")];
const options = { agent, home, stateRoot: config.stateRoot, configPath, executable } as const;
const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), worker: false });
const checks: Record<string, unknown>[] = [];
let nativeVersion: string | undefined;
let failureCode = "native_verification_failed";
async function native(args: string[]) {
 const pending = run("claude", args, { cwd, ...(localModel ? { env: { ...process.env, ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "http://127.0.0.1:11434", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } } : {}), timeout: 180_000, maxBuffer: 4_194_304 }); pending.child.stdin?.end();
 try { return JSON.parse((await pending).stdout); }
 catch (error) {
  const stdout = (error as { stdout?: string }).stdout;
  if (stdout) { try { return JSON.parse(stdout); } catch {} }
  throw new Error("Native Claude invocation failed or timed out; inspect sign-in and CLI availability.");
 }
}
async function publish(passed: boolean, error?: string) {
 const report = { version: 1, createdAt: new Date().toISOString(), agent, nativeVersion, inference: localModel ? { mode: "local-ollama", model: localModel, endpoint: "http://127.0.0.1:11434", fallback: false } : { mode: "existing-account-authentication" }, isolated: true, persistentConfigurationChanged: false, automaticCaptureEnabled: false, checks, passed, ...(error ? { error: { code: error, suggestedFix: error === "authentication_expired" ? "Run claude auth login, then rerun the native verification." : "Inspect the synthetic verification checks and retry." } } : {}), limitations: "Synthetic native print-mode sessions with transient settings. Inference mode is recorded separately; local Ollama mode does not verify subscription authentication. Tests hook context and explicit MCP capture; automatic Stop capture and persistent installation trust are separate checks." };
 const index = process.argv.indexOf("--report");
 if (index >= 0) { if (!process.argv[index + 1]) throw new Error("--report requires a path"); await writeFile(resolve(process.argv[index + 1]), JSON.stringify(report, null, 2) + "\n"); }
 console.log(JSON.stringify(report, null, 2));
}
try {
 await run("git", ["-C", service.engine.repository.root, "config", "user.name", "Native integration fixture"]);
 await run("git", ["-C", service.engine.repository.root, "config", "user.email", "fixture@example.invalid"]);
 const nonce = "Mara-" + randomUUID();
 const forbidden = "forbidden-" + randomUUID();
 const seed = await callLocalService(config, "memory.remember", { text: "The Juniper release owner is " + nonce + ".", provenance: { sourceType: "synthetic-native-fixture" }, idempotencyKey: "seed" }) as { id: string; revision: string; commit: string };
 await callLocalService(config, "memory.remember", { text: "The Juniper secret is " + forbidden + ".", visibility: ["private"], provenance: { sourceType: "synthetic-native-fixture" }, idempotencyKey: "secret" });
 const expected = (await callLocalService(config, "context.deliver", { query: "Juniper" }, { context: { scope: "read", allowedAccessLabels: [] } }) as ContextDelivery).citations.find((citation) => citation.documentId === seed.id);
 if (!expected) throw new Error("Fixture evidence is unavailable");
 await manageAgentHooks(options, "install");
 const hookStatus = await manageAgentHooks(options, "status");
 nativeVersion = (await run("claude", ["--version"])).stdout.trim();
 const base = [...(localModel ? ["--model", localModel] : []), "-p", "--setting-sources", "", "--settings", hookStatus.path, "--tools", "", "--output-format", "json", "--no-session-persistence", "--max-turns", "6", "--max-budget-usd", "0.50", "--strict-mcp-config"];
 const contextPrompt = "This is a synthetic integration test. Answer the user query using only the Manas evidence supplied by hooks. Do not call tools. Reply with JSON containing answer and citations. Copy each citation documentId, revision, commit, startOffset, endOffset exactly from the supplied evidence. If no evidence was supplied, reply with {\"answer\":\"NO_CONTEXT\",\"citations\":[]}.";
 const started = performance.now();
 const context = await native([...base, "--mcp-config", JSON.stringify({ mcpServers: {} }), "--system-prompt", contextPrompt, "Juniper"]);

 const answer = String(context.result ?? "");
 if (context.is_error && answer.includes("OAuth session expired")) failureCode = "authentication_expired";
 const observations = await readHookObservations(config.stateRoot, (await manageAgentMcp(options, "preview")).clientId);
 const delivered = observations.some((value) => value.event === "UserPromptSubmit" && value.outcome === "delivered");
 let parsed: any;
 try { parsed = JSON.parse(answer.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1")); } catch {}
 const exactCitation = parsed?.citations?.some((citation: any) => ["documentId", "revision", "commit", "startOffset", "endOffset"].every((key) => citation[key] === expected[key as keyof typeof expected]));
 const contextPassed = !context.is_error && String(parsed?.answer).includes(nonce) && exactCitation && !answer.includes(forbidden) && delivered;
 checks.push({ name: "hook-context", passed: Boolean(contextPassed), delivered, exactCitation: Boolean(exactCitation), citedDocument: answer.includes(seed.id), citedRevision: answer.includes(expected.revision), citedCommit: answer.includes(expected.commit), excludedPrivateEvidence: !answer.includes(forbidden), latencyMs: Math.round(performance.now() - started), nativeResult: context.subtype });
 if (!contextPassed) { console.error(JSON.stringify({ diagnostic: "Synthetic context result", answer, observations })); throw new Error("Native hook context verification failed."); }
 const mcp = await manageAgentMcp({ ...options, write: true }, "install");
 const mcpPath = join(root, "mcp.json");
 await writeFile(mcpPath, JSON.stringify({ mcpServers: { manas: mcp.entry } }));
 const captureText = "The synthetic Cobalt reviewer is Vale-" + randomUUID() + ".";
 const input = { text: captureText, provenance: { sourceType: "user", sessionId: "native-smoke", turnId: "explicit-capture" }, idempotencyKey: "native:explicit-capture" };
 const prompt = "Use the Manas MCP memory.remember operation with this exact JSON input: " + JSON.stringify(input) + ". Then use memory.recall with query Cobalt. Do not use any other operations. Report whether the write and recall succeeded, including the memory ID.";
 const captureStarted = performance.now();
 const capture = await native([...base, "--mcp-config", mcpPath, "--allowedTools", "mcp__manas__*", "--permission-mode", "dontAsk", "--system-prompt", "You are verifying a synthetic Manas integration. Follow the exact requested MCP operations and do not delegate.", prompt]);

 const recalled = await callLocalService(config, "memory.recall", { query: "Cobalt" }) as { results: Array<{ id: string; text: string }> };
 const records = recalled.results.filter((value) => value.text === captureText);
 const capturePassed = !capture.is_error && records.length === 1 && String(capture.result).includes(records[0]!.id);
 checks.push({ name: "authorized-mcp-capture", passed: capturePassed, memories: records.length, latencyMs: Math.round(performance.now() - captureStarted), nativeResult: capture.subtype });
 if (!capturePassed) { console.error(JSON.stringify({ diagnostic: "Synthetic capture result", result: capture.result, subtype: capture.subtype, memories: records.length })); throw new Error("Native MCP capture verification failed."); }
 await publish(checks.every((check) => check.passed));
} catch {
 await publish(false, failureCode); throw new Error("Native Claude verification failed; inspect the report and authentication status.");
} finally {
 await manageAgentMcp(options, "uninstall").catch(() => {});
 await manageAgentHooks(options, "uninstall").catch(() => {});
 await service.close();
 await rm(root, { recursive: true, force: true });
}
