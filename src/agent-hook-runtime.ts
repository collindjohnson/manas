import { recordHookObservation } from "./agent-hook-observations";
import { basename } from "node:path";
import type { Config } from "./config";
import { callLocalService } from "./local-service";
import type { ContextDelivery } from "./brain/context-delivery";
import type { ManagedAgent } from "./agent-management";
import { CaptureError, capturePolicy } from "./brain/memory-capture";

/** Hooks use the running service and never acquire PGLite ownership. */
export async function runAgentHook(config: Config, agent: ManagedAgent, input: unknown, installationId?: string): Promise<Record<string, unknown>> {
 if (!input || typeof input !== "object" || Array.isArray(input)) return {};
 const event = input as Record<string, unknown>;
 if (!["SessionStart", "UserPromptSubmit", "Stop"].includes(String(event.hook_event_name))) return {};
 let policy: Awaited<ReturnType<typeof capturePolicy>> | undefined;
 if (installationId) { try { policy = await capturePolicy(config.stateRoot, installationId); if (policy.agent !== agent) return {}; } catch { return {}; } }
 const turn = { installationId, sessionId: event.session_id, turnId: event.turn_id };
 const stableTurn = typeof event.session_id === "string" && typeof event.turn_id === "string" && Boolean(event.session_id.trim()) && Boolean(event.turn_id.trim());
 const missingTurn = () => new CaptureError("capture_identity_missing", "Capture has no stable turn identity.", "Use a supported session and turn identifier adapter; no memory was captured.");
 if (event.hook_event_name === "Stop") {
  let error: unknown;
  let outcome = "capture_disabled";
  if (policy?.captureEnabled) {
   if (agent === "claude-code") {
    try { await callLocalService(config, "capture.claude.enqueue", { installationId, sessionId: event.session_id, transcriptPath: event.transcript_path }, { timeoutMs: 1250, context: { scope: "write", tenantId: "local", principal: "hook:" + agent } }); outcome = "queued"; }
    catch (failure) { error = failure; outcome = "capture_failed"; }
   }
   else if (!stableTurn) { error = missingTurn(); outcome = "capture_failed"; }
   else { try { await callLocalService(config, "capture.enqueue", turn, { timeoutMs: 1250, context: { scope: "write", tenantId: "local", principal: "hook:" + agent } }); outcome = "queued"; } catch (failure) { error = failure; outcome = "capture_failed"; } }
  }
  await recordHookObservation(config.stateRoot, installationId, event, outcome, error);
  return {};
 }
 const query = typeof event.prompt === "string" ? event.prompt.slice(0, 2000) : typeof event.cwd === "string" ? basename(event.cwd) : "";
 let captureFailure: unknown = agent === "codex" && policy?.captureEnabled && event.hook_event_name === "UserPromptSubmit" && !stableTurn ? missingTurn() : undefined;
 let deliveryFailure: unknown;
 let delivered = false;
 const stage = agent === "codex" && policy?.captureEnabled && stableTurn && event.hook_event_name === "UserPromptSubmit"
  ? callLocalService(config, "capture.stage", { ...turn, prompt: event.prompt }, { timeoutMs: 1250, context: { scope: "write", tenantId: "local", principal: "hook:" + agent } }).catch((error) => { captureFailure = error; })
  : Promise.resolve();
 const deliver = async () => {
  if (!query.trim()) return {};
  try {
   const result = await callLocalService(config, "context.deliver", { query, maximumTokens: 2000, timeoutMs: 1500 }, { timeoutMs: 1750, context: { scope: "read", principal: "hook:" + agent, tenantId: "local", allowedAccessLabels: policy?.visibility ?? [] } }) as ContextDelivery;
   if (!result.context) return {};
   delivered = true;
   return { hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: result.context } };
  } catch (error) { deliveryFailure = error; return {}; }
 };
 const [result] = await Promise.all([deliver(), stage]);
 await recordHookObservation(config.stateRoot, installationId, event, captureFailure ? "capture_failed" : delivered ? "delivered" : agent === "codex" && policy?.captureEnabled && event.hook_event_name === "UserPromptSubmit" ? "staged" : deliveryFailure ? "unavailable" : "empty", captureFailure ?? deliveryFailure);
 return result;
}
