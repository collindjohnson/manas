import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertManagedParents } from "./agent-management";
import { acquireStoreOwnership, StoreOwnedError } from "./brain/ownership";
import type { Config } from "./config";
import { callLocalService } from "./local-service";
import { readHookObservations } from "./agent-hook-observations";
import { capturePolicy } from "./brain/memory-capture";
import type { ContextDelivery } from "./brain/context-delivery";
import { agentDefinitionHash, beginAgentVerification, verificationHash, verificationInstallationId, writeAgentVerification, type VerificationInstallation } from "./agent-verification-state";
export class AgentVerificationError extends Error {
 constructor(readonly code: string, message: string, readonly suggestedFix: string, readonly retryable = false) { super(message); }
}
export interface NativeVerificationResult { sessionId: string; nativeVersion: string; answer: unknown; noToolCalls: boolean; }
export type NativeVerificationRunner = (options: VerificationInstallation, query: string) => Promise<NativeVerificationResult>;
const schema = { type: "object", additionalProperties: false, required: ["answer", "citations"], properties: { answer: { type: "string" }, citations: { type: "array", items: { type: "object", additionalProperties: false, required: ["documentId", "revision", "commit", "startOffset", "endOffset"], properties: { documentId: { type: "string" }, revision: { type: "string" }, commit: { type: "string" }, startOffset: { type: "integer" }, endOffset: { type: "integer" } } } } } };
const instructions = "Verify the installed Manas context hook. Answer the user query using only Manas evidence supplied by hooks. Do not call tools, read files, or delegate. Return JSON with answer and citations. Copy documentId, revision, commit, startOffset and endOffset exactly from hook evidence. If no hook evidence arrived return NO_CONTEXT and empty citations.";
const run = promisify(execFile);
const fail = (code: string, message: string, fix: string): never => { throw new AgentVerificationError(code, message, fix); };
export const runNativeVerification: NativeVerificationRunner = async (options, query) => {
 const directory = options.agent === "codex" ? ".codex" : ".claude";
 const activeDirectory = options.agent === "codex" ? process.env.CODEX_HOME ?? join(homedir(), directory) : process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), directory);
 if (resolve(options.home, directory) !== resolve(activeDirectory)) return fail("verification_home_mismatch", "The selected installation differs from the active native client configuration directory.", "Select the active installation. Custom Claude installations must match the documented CLAUDE_CONFIG_DIR setting; Codex uses its existing configured home.");
 const cwd = await mkdtemp(join(tmpdir(), "manas-agent-verification-"));
 try {
  const executable = options.agent === "codex" ? "codex" : "claude";
  const nativeVersion = (await run(executable, ["--version"], { timeout: 5000, maxBuffer: 65536 })).stdout.trim();
  const schemaPath = join(cwd, "answer-schema.json");
  await writeFile(schemaPath, JSON.stringify(schema));
  const args = options.agent === "codex"
   ? ["exec", "--ephemeral", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", cwd, "--output-schema", schemaPath, "-c", "mcp_servers={}", "-c", "developer_instructions=" + JSON.stringify(instructions), query]
   : ["-p", "--tools", "", "--output-format", "json", "--max-turns", "2", "--max-budget-usd", "0.50", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--json-schema", JSON.stringify(schema), "--system-prompt", instructions, query];
  const pending = run(executable, args, { cwd, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  pending.child.stdin?.end();
  let stdout: string;
  try { stdout = (await pending).stdout; }
  catch { return fail("native_verification_failed", "The native client could not finish verification.", "Check client sign-in and service health. Review and trust the installed hook in the client, then retry."); }
  if (options.agent === "codex") {
   const events = stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
   const message = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message").at(-1);
   let answer: unknown;
   try { answer = JSON.parse(message?.item.text ?? "null"); } catch {}
   return { sessionId: events.find((event) => event.type === "thread.started")?.thread_id ?? "", nativeVersion, answer, noToolCalls: !events.some((event) => ["mcp_tool_call", "command_execution", "web_search"].includes(event.item?.type)) };
  }
  const result = JSON.parse(stdout);
  if (result.is_error) return fail("native_verification_failed", "Claude Code reported an unsuccessful session.", "Check Claude Code sign-in, hook settings and service health, then retry.");
  let answer = result.structured_output;
  if (!answer) { try { answer = JSON.parse(result.result); } catch {} }
  return { sessionId: result.session_id ?? "", nativeVersion, answer, noToolCalls: true };
 } catch (error) {
  if (error instanceof AgentVerificationError) throw error;
  return fail("native_verification_failed", "The native client is unavailable or returned an invalid verification response.", "Install and sign in to the selected native client, inspect its hook configuration, and retry.");
 } finally { await rm(cwd, { recursive: true, force: true }); }
};
async function performVerification(config: Config, options: VerificationInstallation, query: string, runner: NativeVerificationRunner = runNativeVerification) {
 if (options.stateRoot !== config.stateRoot || typeof query !== "string" || !query.trim() || query.length > 2000) return fail("invalid_verification_input", "Verification requires this runtime state directory and a query of 1 to 2000 characters.", "Supply --config and --query for evidence available to the installed hook grant.");
 const definitionHash = await agentDefinitionHash(options);
 if (!definitionHash) return fail("hooks_not_installed", "The owned hook configuration is not intact.", "Preview and install the agent configuration, then review the hook in the native client.");
 const installationId = verificationInstallationId(options);
 const policy = await capturePolicy(config.stateRoot, installationId);
 const expected = await callLocalService(config, "context.deliver", { query }, { context: { scope: "read", allowedAccessLabels: policy.visibility }, timeoutMs: 2000 }) as ContextDelivery;
 if (!expected.citations.length) return fail("verification_evidence_missing", "No evidence is available to this hook grant.", "Use a query matching an existing memory visible to the installed agent.");
 await beginAgentVerification(options);
 const startedAt = Date.now();
 const result = await runner(options, query);
 if (!result.sessionId || !result.nativeVersion?.trim() || !result.noToolCalls) return fail("verification_session_invalid", "Verification did not produce a tool-free native session.", "Review the native client configuration and retry.");
 const sessionHash = verificationHash(result.sessionId);
 const observations = await readHookObservations(config.stateRoot, installationId);
 const delivered = observations.some((entry) => entry.event === "UserPromptSubmit" && entry.outcome === "delivered" && entry.sessionHash === sessionHash && Date.parse(entry.observedAt) >= startedAt);
 const answer = result.answer as { answer?: unknown; citations?: unknown[] } | undefined;
 const exactCitation = Array.isArray(answer?.citations) && answer.citations.some((candidate) => candidate && expected.citations.some((evidence) => ["documentId", "revision", "commit", "startOffset", "endOffset"].every((key) => (candidate as Record<string, unknown>)[key] === evidence[key as keyof typeof evidence])));
 if (!delivered || !exactCitation || typeof answer?.answer !== "string" || !answer.answer.trim() || answer.answer === "NO_CONTEXT") return fail("verification_context_missing", "The native session did not demonstrate cited hook context.", "Review and trust the exact installed hook, confirm the service is running, and retry with a visible evidence query.");
 const current = await callLocalService(config, "context.deliver", { query }, { context: { scope: "read", allowedAccessLabels: policy.visibility }, timeoutMs: 2000 }) as ContextDelivery;
 const currentCitation = Array.isArray(answer.citations) && answer.citations.some((candidate) => candidate && current.citations.some((evidence) => ["documentId", "revision", "commit", "startOffset", "endOffset"].every((key) => (candidate as Record<string, unknown>)[key] === evidence[key as keyof typeof evidence])));
 if (!currentCitation) return fail("verification_evidence_changed", "Evidence changed during the native verification session.", "Retry with current visible evidence after the brain has finished updating.");
 // Recheck the definition after native execution; configuration changes invalidate the proof.
 const receipt = { version: 1 as const, agent: options.agent, definitionHash, checkedAt: new Date().toISOString(), sessionHash, nativeVersion: result.nativeVersion, trustMode: "normal-client-policy" as const, checks: { contextDelivered: true as const, exactCitation: true as const, noToolCalls: true as const } };
 if (!await writeAgentVerification(options, receipt)) return fail("verification_configuration_changed", "Agent configuration changed during verification.", "Retry with the current installation.");
 return { integrationObserved: true, verification: receipt, automaticCaptureVerified: false };
}

export async function verifyAgentIntegration(config: Config, options: VerificationInstallation, query: string, runner: NativeVerificationRunner = runNativeVerification) {
 if (options.stateRoot !== config.stateRoot || typeof query !== "string" || !query.trim() || query.length > 2000) return fail("invalid_verification_input", "Verification requires this runtime state directory and a query of 1 to 2000 characters.", "Supply --config and --query for evidence available to the installed hook grant.");
 const directory = join(config.stateRoot, "agent-integrations", verificationInstallationId(options) + "-verification-lock");
 await assertManagedParents(join(directory, ".manas-owner.sqlite"));
 let release: () => void;
 try { release = await acquireStoreOwnership(directory); }
 catch (error) { if (error instanceof StoreOwnedError) throw new AgentVerificationError("verification_in_progress", "This agent installation is already being verified.", "Wait for that verification to finish, then retry.", true); throw error; }
 try { return await performVerification(config, options, query, runner); }
 finally { release(); }
}
