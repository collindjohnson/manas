import { readAgentVerification } from "./agent-verification-state";
import { readHookObservations } from "./agent-hook-observations";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ManagedAgent } from "./agent-management";
import { assertManagedParents, readManagedFile, writeManagedFile } from "./agent-management";
import { acquireStoreOwnership } from "./brain/ownership";
export interface AgentHookOptions { agent: ManagedAgent; home: string; stateRoot: string; configPath: string; executable: string[]; capture?: boolean; visibility?: string[]; }
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function object(value: string | undefined): Record<string, unknown> {
 const result = JSON.parse(value ?? "{}");
 if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("hook settings must be a JSON object");
 return result;
}
export async function manageAgentHooks(options: AgentHookOptions, action: "preview" | "install" | "status" | "uninstall") {
 if (!options.configPath || !options.executable.length) throw new Error("hooks require an explicit configuration and executable");
 const id = createHash("sha256").update(options.agent + ":" + resolve(options.home)).digest("hex");
 const target = join(resolve(options.home), options.agent === "codex" ? ".codex" : ".claude", options.agent === "codex" ? "hooks.json" : "settings.json");
 const receiptPath = join(options.stateRoot, "agent-integrations", id + "-hooks.json");
 const command = [...options.executable, "--config", resolve(options.configPath), "hook", "--agent", options.agent, "--installation", id].map(quote).join(" ");
 const group = { hooks: [{ type: "command", command, timeout: 2 }] };
 await assertManagedParents(join(options.stateRoot, "agent-integrations", ".manas-owner.sqlite"));
 const release = ["install", "uninstall"].includes(action) ? await acquireStoreOwnership(join(options.stateRoot, "agent-integrations")) : undefined;
 try {
  const before = await readManagedFile(target), configuration = object(before);
  const stored = await readManagedFile(receiptPath), receipt = stored ? object(stored) : undefined;
  const previous = receipt?.group;
  const previousGroups = [previous, receipt?.previousGroup].filter(Boolean);
  const hooks = configuration.hooks ?? {};
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks) || Object.values(hooks).some((value) => !Array.isArray(value))) throw new Error("existing hooks are invalid");
  const groups = hooks as Record<string, unknown[]>;
  const captureEnabled = action === "install" || action === "preview" ? options.capture === true : receipt?.captureEnabled === true;

  const visibility = options.visibility ?? (["status", "uninstall"].includes(action) && Array.isArray(receipt?.visibility) ? receipt.visibility as string[] : captureEnabled ? ["personal"] : []);
  if (visibility.some((label) => typeof label !== "string" || !label.trim() || label.length > 128) || visibility.length > 32) throw new Error("invalid capture visibility labels");
  const unchangedGrant = receipt?.captureEnabled === true && JSON.stringify(receipt.visibility) === JSON.stringify(visibility);
  const captureEnabledAt = captureEnabled ? unchangedGrant && typeof receipt?.captureEnabledAt === "string" ? receipt.captureEnabledAt : new Date().toISOString() : undefined;
  const captureEpoch = captureEnabled ? unchangedGrant && typeof receipt?.captureEpoch === "string" ? receipt.captureEpoch : randomUUID() : undefined;
  const events = ["SessionStart", "UserPromptSubmit", ...(captureEnabled ? ["Stop"] : [])];
  const ownedEvents = [...new Set([...events, ...(Array.isArray(receipt?.events) ? receipt.events as string[] : []), ...(Array.isArray(receipt?.previousEvents) ? receipt.previousEvents as string[] : [])])];
  if (ownedEvents.some((event) => !["SessionStart", "UserPromptSubmit", "Stop"].includes(event))) throw new Error("invalid hook ownership receipt");
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const installed = events.every((event) => (groups[event] ?? []).some((value) => same(value, previous ?? group)));
  const observations = await readHookObservations(options.stateRoot, id);
  const verification = installed ? await readAgentVerification(options) : undefined;
  const status = { verification, observations, hookInvocationObserved: observations.length > 0, path: target, hooksInstalled: installed, hookTrust: verification ? "observed-at-verification" : options.agent === "codex" ? "requires-review" : "unknown", integrationObserved: Boolean(verification), captureEnabled, captureEnabledAt, grantedVisibility: visibility, command };
  if (action === "preview" || action === "status") return status;
  if (action === "uninstall" && !receipt) return { ...status, removed: false };
  const nextReceipt = { version: 1, verificationEpoch: randomUUID(), agent: options.agent, home: resolve(options.home), captureEnabled, captureEnabledAt, captureEpoch, visibility, events, group, original: receipt?.original ?? before ?? null };
  if (action === "install") {
   if (!previous && installed) throw new Error("matching hooks already exist without a Manas ownership receipt");
   await writeManagedFile(receiptPath, serialize({ ...nextReceipt, captureEnabled: false, previousGroup: previousGroups.find((candidate) => Object.values(groups).some((values) => values.some((value) => same(value, candidate)))), previousEvents: ownedEvents }));
  } else {
   // Revoke pending capture before touching user configuration.
   await writeManagedFile(receiptPath, serialize({ ...receipt, captureEnabled: false }));
  }
  for (const event of ownedEvents) {
   groups[event] = (groups[event] ?? []).filter((value) => !previousGroups.some((candidate) => same(value, candidate)));
   if (action === "install" && events.includes(event)) groups[event].push(group);
   if (!groups[event].length) delete groups[event];
  }
  if (await readManagedFile(target) !== before) throw new Error("hook settings changed; retry");
  if (Object.keys(groups).length) configuration.hooks = groups; else delete configuration.hooks;
  await writeManagedFile(target, serialize(configuration));
  if (action === "install") await writeManagedFile(receiptPath, serialize(nextReceipt));
  if (action === "uninstall") await writeManagedFile(receiptPath, serialize({ version: 1, original: receipt?.original ?? null, captureEnabled: false, group: undefined }));
  return { ...status, verification: undefined, integrationObserved: false, hookTrust: options.agent === "codex" ? "requires-review" : "unknown", hooksInstalled: action === "install", captureEnabled: action === "install" && captureEnabled, nextStep: options.agent === "codex" ? "Review and trust commands using /hooks in Codex." : "Review the installed hooks in Claude Code." };
 } finally { release?.(); }
}
