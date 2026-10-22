import { createHash } from "node:crypto";
import { join } from "node:path";
import { readManagedFile, writeManagedFile } from "./agent-management";
export interface HookObservation { event: string; observedAt: string; sessionHash?: string; turnHash?: string; outcome: string; code?: string; suggestedFix?: string; }
const events = ["SessionStart", "UserPromptSubmit", "Stop"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export async function recordHookObservation(stateRoot: string, installationId: string | undefined, event: Record<string, unknown>, outcome: string, error?: unknown) {
 if (!installationId || !/^[a-f0-9]{64}$/.test(installationId) || !events.includes(String(event.hook_event_name))) return;
 const failure = error as { code?: unknown; suggestedFix?: unknown } | undefined;
 const observation: HookObservation = { event: String(event.hook_event_name), observedAt: new Date().toISOString(), outcome,
  ...(typeof event.session_id === "string" ? { sessionHash: hash(event.session_id) } : {}),
  ...(typeof event.turn_id === "string" ? { turnHash: hash(event.turn_id) } : {}),
  ...(error ? { code: typeof failure?.code === "string" ? failure.code : "hook_operation_failed", suggestedFix: typeof failure?.suggestedFix === "string" ? failure.suggestedFix : "Inspect the service and agent installation status." } : {}),
 };
 try { await writeManagedFile(join(stateRoot, "agent-integrations", installationId + "-observed-" + observation.event + ".json"), JSON.stringify(observation) + "\n"); }
 catch { /* Hooks must not stall a turn when operational state is unavailable. */ }
}
export async function readHookObservations(stateRoot: string, installationId: string): Promise<HookObservation[]> {
 if (!/^[a-f0-9]{64}$/.test(installationId)) throw new Error("invalid hook installation ID");
 const values = await Promise.all(events.map(async (event) => {
  const text = await readManagedFile(join(stateRoot, "agent-integrations", installationId + "-observed-" + event + ".json"));
  if (!text) return;
  const value = JSON.parse(text) as HookObservation;
  if (value.event !== event || !Number.isFinite(Date.parse(value.observedAt)) || typeof value.outcome !== "string") throw new Error("invalid hook observation");
  return value;
 }));
 return values.filter((value): value is HookObservation => Boolean(value));
}
