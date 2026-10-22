import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { acquireStoreOwnership } from "./brain/ownership";
import { isScopedClientOperation, OperationRegistry, type OperationContext } from "./brain/operation-registry";
import { assertManagedParents, readManagedFile, writeManagedFile, type ManagedAgent } from "./agent-management";

export interface AgentMcpOptions { agent: ManagedAgent; home: string; stateRoot: string; configPath: string; executable: string[]; write?: boolean; visibility?: string[]; }
export class ClientAccessError extends Error {
 readonly code = "client_access_denied"; readonly retryable = false;
 readonly suggestedFix = "Ask the owner to install or update this client grant, then reconnect.";
 constructor() { super("Manas client access is unavailable or revoked."); }
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function canonical(value: unknown): string {
 if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
 if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
 return JSON.stringify(value);
}
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function object(text: string | undefined): Record<string, unknown> {
 const value = JSON.parse(text ?? "{}");
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP settings must be an object");
 return value;
}
export function agentClientId(agent: ManagedAgent, home: string) { return createHash("sha256").update(agent + ":" + resolve(home)).digest("hex"); }
function bindingPath(stateRoot: string, id: string) {
 if (!/^[a-f0-9]{64}$/.test(id)) throw new ClientAccessError();
 return join(stateRoot, "agent-integrations", id + "-client.json");
}
export async function resolveClientGrant(stateRoot: string, id: string): Promise<OperationContext> {
 let value: Record<string, unknown>;
 try { value = object(await readManagedFile(bindingPath(stateRoot, id))); } catch { throw new ClientAccessError(); }
 if (value.version !== 1 || value.active !== true || !["read", "write"].includes(String(value.scope)) || !Array.isArray(value.visibility) || value.visibility.length > 32 || value.visibility.some((label) => typeof label !== "string" || !label.trim() || label.length > 128)) throw new ClientAccessError();
 return { scope: value.scope as "read" | "write", principal: "client:" + id, tenantId: "local", allowedAccessLabels: value.visibility as string[] };
}
/** Recheck the owner-managed grant for every request, including already-connected clients. */
export async function liveClientRegistry(registry: OperationRegistry, stateRoot: string, id: string): Promise<OperationRegistry> {
 const initial = await resolveClientGrant(stateRoot, id), result = new OperationRegistry();
 const rank = { read: 1, write: 2, admin: 3 };
 for (const definition of registry.list()) {
  if (!isScopedClientOperation(definition) || rank[definition.requiredScope] > rank[initial.scope]) continue;
  result.register({ ...definition, execute: async (context, input) => {
   const grant = await resolveClientGrant(stateRoot, id);
   const output = await registry.execute({ ...grant, signal: context.signal }, definition.name, input);
   if (!same(grant, await resolveClientGrant(stateRoot, id))) throw new ClientAccessError();
   return output;
  } });
 }
 return result;
}
export async function manageAgentMcp(options: AgentMcpOptions, action: "preview" | "install" | "status" | "uninstall") {
 if (!["codex", "claude-code"].includes(options.agent) || !options.home || !options.configPath || !options.executable.length || options.executable.some((part) => typeof part !== "string" || !part || part.includes("\0"))) throw new Error("MCP installation needs an explicit configuration and executable");
 const visibility = options.visibility ?? [];
 if (!Array.isArray(visibility) || visibility.length > 32 || visibility.some((label) => typeof label !== "string" || !label.trim() || label.length > 128)) throw new Error("invalid MCP visibility grant");
 const id = agentClientId(options.agent, options.home);
 const root = join(options.stateRoot, "agent-integrations"), receiptPath = join(root, id + "-mcp.json");
 const target = options.agent === "codex" ? join(resolve(options.home), ".codex", "config.toml") : join(resolve(options.home), ".claude.json");
 const args = [...options.executable.slice(1), "--config", resolve(options.configPath), "serve", "--client", id];
 const entry = options.agent === "codex" ? { command: options.executable[0], args } : { type: "stdio", command: options.executable[0], args };
 const begin = "# Manas managed MCP begin " + id, end = "# Manas managed MCP end " + id;
 const block = begin + "\n[mcp_servers.manas]\ncommand = " + JSON.stringify(entry.command) + "\nargs = " + JSON.stringify(args) + "\n" + end + "\n";
 await assertManagedParents(join(root, ".manas-owner.sqlite"));
 const release = ["install", "uninstall"].includes(action) ? await acquireStoreOwnership(root) : undefined;
 try {
  const before = await readManagedFile(target);
  const receiptText = await readManagedFile(receiptPath), receipt = receiptText ? object(receiptText) : undefined;
  const configuration = options.agent === "codex" ? Bun.TOML.parse(before ?? "") as Record<string, unknown> : object(before);
  const mapName = options.agent === "codex" ? "mcp_servers" : "mcpServers";
  const servers = configuration[mapName] ?? {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("existing MCP servers must be an object");
  const current = (servers as Record<string, unknown>).manas;
  const candidates = receipt ? [{ entry: receipt.entry, block: receipt.block }, { entry: receipt.previousEntry, block: receipt.previousBlock }] : [];
  const matched = candidates.find((candidate) => {
   if (candidate.entry === undefined || !same(current, candidate.entry)) return false;
   if (options.agent !== "codex") return true;
   if (typeof candidate.block !== "string" || !before?.includes(candidate.block)) return false;
   try {
    const stripped = Bun.TOML.parse(before.replace(candidate.block, "")) as Record<string, unknown>;
    return !(stripped.mcp_servers as Record<string, unknown> | undefined)?.manas;
   } catch { return false; }
  });
  const owned = Boolean(matched);
  const conflicting = current !== undefined && !owned;
  let grant: OperationContext | undefined;
  try { grant = await resolveClientGrant(options.stateRoot, id); } catch { /* Status distinguishes configured files from an active grant. */ }
  const status = { path: target, clientId: id, configurationInstalled: owned, grantActive: Boolean(grant), scope: grant?.scope, visibility: grant?.allowedAccessLabels, action: conflicting ? "conflict" : current === undefined ? "create" : "update", entry };
  if (action === "preview" || action === "status") return status;
  if (action === "uninstall") {
   // Revocation precedes config removal, even when a user's edits must be preserved.
   await writeManagedFile(bindingPath(options.stateRoot, id), json({ version: 1, active: false }));
   if (!owned) return { ...status, grantActive: false, removed: false, preserved: current !== undefined };
  } else if (conflicting) throw new Error("Existing manas MCP configuration is not owned by this installation; inspect preview or use --no-mcp.");
  let next: string;
  if (options.agent === "codex") {
   const stripped = owned ? (before ?? "").replace(String(matched!.block), "") : before ?? "";
   next = action === "install" ? stripped + (stripped.endsWith("\n") || !stripped ? "" : "\n") + block : stripped;
   const parsed = Bun.TOML.parse(next) as Record<string, unknown>;
   if (action === "install" && !same((parsed.mcp_servers as Record<string, unknown>)?.manas, entry)) throw new Error("generated Codex MCP settings failed validation");
  } else {
   if (action === "install") (servers as Record<string, unknown>).manas = entry; else delete (servers as Record<string, unknown>).manas;
   if (Object.keys(servers).length) configuration[mapName] = servers; else delete configuration[mapName];
   next = json(configuration);
  }
  if (action === "install") {
   await writeManagedFile(receiptPath, json({ version: 1, entry, ...(options.agent === "codex" ? { block } : {}), previousEntry: matched?.entry, previousBlock: matched?.block, original: receipt?.original ?? before ?? null }));
  }
  if (await readManagedFile(target) !== before) throw new Error("MCP configuration changed during installation; retry");
  await writeManagedFile(target, next);
  if (action === "install") {
   await writeManagedFile(bindingPath(options.stateRoot, id), json({ version: 1, active: true, agent: options.agent, scope: options.write ? "write" : "read", visibility }));
   await writeManagedFile(receiptPath, json({ version: 1, entry, ...(options.agent === "codex" ? { block } : {}), original: receipt?.original ?? before ?? null }));
  }
  return { ...status, configurationInstalled: action === "install", grantActive: action === "install", scope: action === "install" ? options.write ? "write" : "read" : undefined, visibility: action === "install" ? visibility : undefined, removed: action === "uninstall" };
 } finally { release?.(); }
}
