import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireStoreOwnership } from "./brain/ownership";

export class DeviceAccessError extends Error {
 constructor(readonly code: string, message: string, readonly retryable = false, readonly suggestedFix = "Inspect devices status and resolve the reported configuration conflict.") { super(message); }
}
export type TailscaleRunner = (args: string[]) => Promise<string>;
const exec = promisify(execFile);
export async function resolveTailscaleExecutable(candidates = [Bun.which("tailscale"), "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
 for (const path of candidates) {
  if (!path || !path.startsWith(String.fromCharCode(47))) continue;
  try { await access(path, constants.X_OK); return path; } catch {}
 }
 throw new DeviceAccessError("tailscale_unavailable", "The Tailscale CLI is not installed.", false, "Install the Tailscale macOS CLI, then retry from the owner service.");
}
export const runTailscale: TailscaleRunner = async (args) => {
 if (process.platform !== "darwin") throw new DeviceAccessError("unsupported_platform", "Device access installation requires macOS.");
 try { return (await exec(await resolveTailscaleExecutable(), args, { timeout: 10_000, maxBuffer: 4_194_304 })).stdout; }
 catch { throw new DeviceAccessError("tailscale_unavailable", "Tailscale command failed or timed out.", true, "Install and sign in to Tailscale, then inspect tailscale serve status and retry."); }
};
type Json = Record<string, unknown>;
function object(value: unknown): value is Json { return !!value && typeof value === "object" && !Array.isArray(value); }
function parse(raw: string): Json { try { const value = JSON.parse(raw); if (object(value)) return value; } catch {} throw new DeviceAccessError("tailscale_invalid_response", "Tailscale returned an invalid configuration.", true); }
function stable(value: unknown): string {
 if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stable(item))));
 if (object(value)) return JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, JSON.parse(stable(item))])));
 return JSON.stringify(value);
}
export interface DeviceSettings { deviceIds: string[]; visibility?: string[]; write?: boolean; httpsPort?: number; publicFunnel?: boolean }
export interface DeviceReceipt {
 version: 1; brainId: string; phase: "installing" | "active" | "disabled";
 hostname: string; httpsPort: number; socket: string; deviceIds: string[]; visibility: string[]; write: boolean; publicFunnel: boolean;
}
export function deviceAccessPaths(stateRoot: string) {
 const root = join(resolve(stateRoot), "device-access");
 const socketRoot = join("/tmp", "manas-dev-" + (process.getuid?.() ?? "local") + "-" + createHash("sha256").update(root).digest("hex").slice(0, 16));
 return { root, receipt: join(root, "state.json"), lock: join(root, "ownership"), socket: join(socketRoot, "mcp.sock") };
}
function normalize(input: DeviceSettings) {
 if (!object(input) || Object.keys(input).some((key) => !["deviceIds", "visibility", "write", "httpsPort", "publicFunnel"].includes(key)) || !Array.isArray(input.deviceIds) || input.deviceIds.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) || input.deviceIds.length > 256) throw new DeviceAccessError("invalid_device_settings", "Select explicit stable device IDs from devices peers.");
 if (input.visibility !== undefined && (!Array.isArray(input.visibility) || input.visibility.length > 256 || input.visibility.some((label) => typeof label !== "string" || !label.trim() || label.length > 128 || /[\u0000-\u001f]/u.test(label)))) throw new DeviceAccessError("invalid_device_settings", "Visibility must be a bounded list of access labels.");
 if (input.write !== undefined && typeof input.write !== "boolean" || input.publicFunnel !== undefined && typeof input.publicFunnel !== "boolean") throw new DeviceAccessError("invalid_device_settings", "Write and publicFunnel must be explicit booleans.");
 const httpsPort = input.httpsPort ?? 8443;
 if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535 || input.publicFunnel && ![443, 8443, 10000].includes(httpsPort)) throw new DeviceAccessError("invalid_device_settings", "Select a valid HTTPS port; Funnel supports 443, 8443, or 10000.");
 if (!input.deviceIds.length && !input.publicFunnel) throw new DeviceAccessError("invalid_device_settings", "Private Serve requires at least one selected device.");
 return { deviceIds: [...new Set(input.deviceIds)].sort(), visibility: [...new Set(input.visibility ?? [])].sort(), write: input.write ?? false, publicFunnel: input.publicFunnel ?? false, httpsPort };
}
function map(config: Json, key: string): Json { const value = config[key]; if (value === undefined || value === null) return {}; if (!object(value)) throw new DeviceAccessError("tailscale_invalid_response", "Tailscale configuration contains an invalid map."); return value; }
function portView(config: Json, port: number): Json {
 const suffix = ":" + port;
 return { TCP: map(config, "TCP")[String(port)] ?? null, Web: Object.fromEntries(Object.entries(map(config, "Web")).filter(([key]) => key.endsWith(suffix))), AllowFunnel: Object.fromEntries(Object.entries(map(config, "AllowFunnel")).filter(([key, value]) => key.endsWith(suffix) && value !== false)) };
}
function foregroundConflict(config: Json, port: number): boolean { return Object.values(map(config, "Foreground")).some((value) => !object(value) || occupied(value, port)); }
function occupied(config: Json, port: number): boolean {
 const view = portView(config, port);
 return view.TCP !== null || Object.keys(view.Web as Json).length > 0 || Object.keys(view.AllowFunnel as Json).length > 0 || foregroundConflict(config, port);
}
function expected(receipt: DeviceReceipt): Json {
 const hostPort = receipt.hostname + ":" + receipt.httpsPort;
 return { TCP: { HTTPS: true }, Web: { [hostPort]: { Handlers: { "/manas": { Proxy: "unix:" + receipt.socket } } } }, AllowFunnel: receipt.publicFunnel ? { [hostPort]: true } : {} };
}
function owned(config: Json, receipt: DeviceReceipt): boolean { return !foregroundConflict(config, receipt.httpsPort) && stable(portView(config, receipt.httpsPort)) === stable(expected(receipt)); }
function unrelated(config: Json, port: number): string {
 const value = structuredClone(config);
 if (object(value.TCP)) { delete value.TCP[String(port)]; if (!Object.keys(value.TCP).length) delete value.TCP; }
 for (const key of ["Web", "AllowFunnel"]) if (object(value[key])) { for (const host of Object.keys(value[key])) if (host.endsWith(":" + port)) delete value[key][host]; if (!Object.keys(value[key]).length) delete value[key]; }
 return stable(value);
}
async function privateDirectory(path: string) {
 await mkdir(path, { recursive: true, mode: 0o700 });
 const info = await lstat(path);
 if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new DeviceAccessError("unsafe_device_state", "Device access state must be in an owner-only directory.");
}
export class DeviceInstallation {
 readonly paths;
 constructor(readonly stateRoot: string, readonly brainId: string, readonly runner: TailscaleRunner = runTailscale) { this.paths = deviceAccessPaths(stateRoot); }
 async peers() {
  const status = parse(await this.runner(["status", "--json"]));
  if (status.BackendState !== "Running" || !object(status.Self) || typeof status.Self.DNSName !== "string") throw new DeviceAccessError("tailscale_offline", "Tailscale must be connected.", true);
  const hostname = status.Self.DNSName.replace(/\.$/, "").toLowerCase();
  if (!/^[a-z0-9.-]+\.ts\.net$/.test(hostname)) throw new DeviceAccessError("tailscale_invalid_hostname", "Tailscale did not return a valid HTTPS hostname.");
  const peers = [status.Self, ...Object.values(map(status, "Peer"))].filter(object).filter((peer) => typeof peer.ID === "string").map((peer) => ({ id: String(peer.ID), name: typeof peer.HostName === "string" ? peer.HostName : String(peer.ID), online: peer.Online === true }));
  return { hostname, peers };
 }
 async receipt(): Promise<DeviceReceipt | undefined> {
  try { const info = await lstat(this.paths.root); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw new DeviceAccessError("unsafe_device_state", "Device state directory is unsafe."); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let raw: string;
  try {
   const info = await lstat(this.paths.receipt);
   if (!info.isFile() || info.isSymbolicLink() || info.size > 262144 || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw new DeviceAccessError("unsafe_device_state", "Device access receipt must be an owner-only regular file.");
   raw = await readFile(this.paths.receipt, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const value = parse(raw) as unknown as DeviceReceipt;
  const normalized = normalize({ deviceIds: value.deviceIds, visibility: value.visibility, write: value.write, publicFunnel: value.publicFunnel, httpsPort: value.httpsPort });
  if (value.version !== 1 || value.brainId !== this.brainId || !["installing", "active", "disabled"].includes(value.phase) || value.socket !== this.paths.socket || typeof value.hostname !== "string" || !/^[a-z0-9.-]+\.ts\.net$/.test(value.hostname)) throw new DeviceAccessError("invalid_device_receipt", "Device access ownership receipt does not match this installation.");
  return { ...value, ...normalized };
 }
 private async save(receipt: DeviceReceipt) {
  await privateDirectory(this.paths.root);
  const path = this.paths.receipt + "." + randomUUID() + ".tmp";
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(receipt) + "\n"); await file.sync(); } finally { await file.close(); }
  try { await rename(path, this.paths.receipt); const dir = await open(this.paths.root, "r"); try { await dir.sync(); } finally { await dir.close(); } }
  finally { await unlink(path).catch(() => {}); }
 }
 async preview(input: DeviceSettings) {
  const settings = normalize(input);
  const [{ hostname, peers }, configuration, previous] = await Promise.all([this.peers(), this.runner(["serve", "status", "--json"]).then(parse), this.receipt()]);
  if (settings.deviceIds.some((id) => !peers.some((peer) => peer.id === id))) throw new DeviceAccessError("unknown_device", "A selected device is no longer in this tailnet.");
  const receipt: DeviceReceipt = { version: 1, brainId: this.brainId, phase: "installing", hostname, socket: this.paths.socket, ...settings };
  const isOwned = !!previous && previous.phase !== "disabled" && owned(configuration, previous);
  const conflict = occupied(configuration, settings.httpsPort) && !(isOwned && previous!.httpsPort === settings.httpsPort && previous!.hostname === hostname);
  const differentEndpoint = !!previous && previous.phase !== "disabled" && (previous.httpsPort !== settings.httpsPort || previous.hostname !== hostname || previous.publicFunnel !== settings.publicFunnel);
  return { receipt, configuration, conflict: conflict || differentEndpoint, owned: isOwned, url: "https://" + hostname + (settings.httpsPort === 443 ? "" : ":" + settings.httpsPort) + "/manas", command: [settings.publicFunnel ? "funnel" : "serve", "--bg", "--yes", "--https=" + settings.httpsPort, "--set-path=/manas", "unix:" + this.paths.socket] };
 }
 async status() {
  const receipt = await this.receipt();
  if (!receipt) return { installed: false, owned: false, receipt: null };
  const config = parse(await this.runner(["serve", "status", "--json"]));
  return { installed: occupied(config, receipt.httpsPort), owned: owned(config, receipt), receipt };
 }
 async enable(input: DeviceSettings, startGateway: (receipt: DeviceReceipt) => Promise<void>) {
  await privateDirectory(this.paths.root);
  const release = await acquireStoreOwnership(this.paths.lock);
  try {
   const preview = await this.preview(input);
   if (preview.conflict) throw new DeviceAccessError("device_configuration_conflict", "The selected listener is unowned, edited, or a different endpoint is still installed. Existing Tailscale configuration was preserved.");
   // Persist intent first: an interrupted successful command can be recognized on restart.
   await this.save(preview.receipt);
   await startGateway(preview.receipt);
   if (stable(parse(await this.runner(["serve", "status", "--json"]))) !== stable(preview.configuration)) throw new DeviceAccessError("device_configuration_conflict", "Tailscale configuration changed before installation. Existing listeners were preserved.");
   await this.runner(preview.command);
   const after = parse(await this.runner(["serve", "status", "--json"]));
   if (!owned(after, preview.receipt) || unrelated(preview.configuration, preview.receipt.httpsPort) !== unrelated(after, preview.receipt.httpsPort)) throw new DeviceAccessError("device_configuration_conflict", "Tailscale configuration changed unexpectedly. The gateway must remain disabled; inspect the listener before retrying.");
   const receipt = { ...preview.receipt, phase: "active" as const };
   await this.save(receipt);
   return receipt;
  } finally { release(); }
 }
 async disable(previewOnly = false) {
  if (previewOnly) { const state = await this.status(); return { ...state, conflict: state.installed && !state.owned }; }
  await privateDirectory(this.paths.root);
  const release = await acquireStoreOwnership(this.paths.lock);
  try {
   const state = await this.status();
   if (!state.receipt) return state;
   // Revoke the local grant even if an edited Tailscale listener must be preserved.
   await this.save({ ...state.receipt, phase: "disabled" });
   if (state.installed && !state.owned) throw new DeviceAccessError("device_configuration_conflict", "The edited Tailscale listener was preserved. Manas access is disabled; remove the listener manually after reviewing it.");
   if (state.installed) {
    const before = parse(await this.runner(["serve", "status", "--json"]));
    if (!owned(before, state.receipt)) throw new DeviceAccessError("device_configuration_conflict", "The Tailscale listener changed during removal and was preserved.");
    await this.runner([state.receipt.publicFunnel ? "funnel" : "serve", "--bg", "--yes", "--https=" + state.receipt.httpsPort, "--set-path=/manas", "off"]);
    const after = parse(await this.runner(["serve", "status", "--json"]));
    if (occupied(after, state.receipt.httpsPort) || unrelated(before, state.receipt.httpsPort) !== unrelated(after, state.receipt.httpsPort)) throw new DeviceAccessError("device_configuration_conflict", "Tailscale removal did not match the owned configuration. Inspect devices status.");
   }
   return { installed: false, owned: false, receipt: { ...state.receipt, phase: "disabled" as const } };
  } finally { release(); }
 }
}
