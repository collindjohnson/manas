import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrainEngine } from "./engine";
import { isScopedClientOperation, OperationRegistry, type OperationContext, type OperationDefinition } from "./brain/operation-registry";
import { authorizePersonalAccessToken, identifyPersonalAccessToken } from "./brain/access-tokens";
import { SqlTenantDirectory } from "./brain/tenancy";
import { McpRateLimiter, serveMcpHttp } from "./mcp/http";
import { createDeviceRequestAuthorizer } from "./device-access";
import { DeviceAccessError, DeviceInstallation, runTailscale, type DeviceReceipt, type DeviceSettings, type TailscaleRunner } from "./device-installation";

export class DeviceAccessController {
 private receipt: DeviceReceipt | undefined;
 private server: ReturnType<typeof serveMcpHttp> | undefined;
 private epoch = 0;
 private stopped = false;
 private pending: Promise<unknown> = Promise.resolve();
 private readonly requests = new Set<Promise<unknown>>();
 private failure: { code: string; message: string; retryable: boolean; suggestedFix: string } | null = null;
 readonly installation: DeviceInstallation;
 private constructor(readonly engine: BrainEngine, brainId: string, readonly runner: TailscaleRunner) { this.installation = new DeviceInstallation(engine.config.stateRoot, brainId, runner); }
 static async create(engine: BrainEngine, runner: TailscaleRunner = runTailscale) {
  if (!engine.store) throw new Error("Device access requires the service operational store.");
  const controller = new DeviceAccessController(engine, (await engine.repository.getIdentity()).brainId, runner);
  return controller;
 }
 private serialize<T>(action: () => Promise<T>): Promise<T> {
  if (this.stopped) return Promise.reject(new DeviceAccessError("service_stopping", "Device access service is stopping.", true));
  const next = this.pending.then(action); this.pending = next.catch(() => {}); return next;
 }
 private async stopGateway() {
  this.epoch++; this.receipt = undefined;
  const server = this.server; this.server = undefined;
  await server?.stop(true);
  await Promise.allSettled([...this.requests]);
 }
 private active(): DeviceReceipt {
  if (this.stopped || !this.receipt || this.receipt.phase !== "active") throw new DeviceAccessError("device_access_disabled", "Device access is disabled.");
  return this.receipt;
 }
 private async authorization(context: OperationContext, definition: OperationDefinition, input: Record<string, unknown>) {
  const receipt = this.active();
  if (context.tenantId !== "local" || input.tenantId !== undefined && input.tenantId !== "local" || input.brainId !== undefined && input.brainId !== receipt.brainId || definition.requiredScope === "admin" || definition.requiredScope === "write" && !receipt.write) throw new DeviceAccessError("device_access_denied", "This operation is outside the device grant.");
  const records = await this.engine.store!.query<{ user_id: string | null; scopes: unknown }>("SELECT user_id, scopes FROM brain_access_tokens WHERE id = $1 AND tenant_id = 'local' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)", [context.principal ?? "", new Date().toISOString()]);
  const token = records[0];
  const scopes = token && (typeof token.scopes === "string" ? JSON.parse(token.scopes) : token.scopes);
  if (!token || !Array.isArray(scopes) || !scopes.includes(definition.requiredScope) && !scopes.includes("admin") || (token.user_id ?? undefined) !== context.userId) throw new DeviceAccessError("device_access_denied", "The client token is no longer authorized.");
  let labels = [...receipt.visibility];
  if (context.userId) {
   const allowed = (await new SqlTenantDirectory(this.engine.store!).authorizeWithLabels(context.userId, "local", receipt.brainId, definition.requiredScope)).allowedAccessLabels;
   if (allowed) labels = labels.filter((label) => allowed.includes(label));
  }
  if (Array.isArray(input.labels) && input.labels.some((label) => typeof label !== "string" || !labels.includes(label))) throw new DeviceAccessError("device_access_denied", "Requested labels exceed the device visibility grant.");
  return labels.sort();
 }
 private registry(receipt: DeviceReceipt) {
  const registry = new OperationRegistry();
  for (const definition of this.engine.operations.list()) {
   if (!isScopedClientOperation(definition) || definition.requiredScope === "admin" || definition.requiredScope === "write" && !receipt.write) continue;
   registry.register({ ...definition, execute: (context, input) => {
    const work = (async () => {
     const epoch = this.epoch;
     const labels = await this.authorization(context, definition, input as Record<string, unknown>);
     const result = await this.engine.operations.execute({ ...context, brainId: receipt.brainId, allowedAccessLabels: labels, authorize: undefined }, definition.name, input);
     const after = await this.authorization(context, definition, input as Record<string, unknown>);
     if (epoch !== this.epoch || JSON.stringify(labels) !== JSON.stringify(after)) throw new DeviceAccessError("device_access_changed", "Device authorization changed while the request was running.", true, "Retry with the current client permissions.");
     return result;
    })();
    this.requests.add(work); void work.finally(() => this.requests.delete(work)).catch(() => {}); return work;
   } });
  }
  return registry;
 }
 private async startGateway(receipt: DeviceReceipt) {
  await this.stopGateway();
  if (this.stopped) throw new DeviceAccessError("service_stopping", "Device access service is stopping.", true);
  const root = dirname(receipt.socket);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw new DeviceAccessError("unsafe_device_socket", "The device socket requires an owner-only directory.");
  try { const socket = await lstat(receipt.socket); if (!socket.isSocket()) throw new DeviceAccessError("device_socket_occupied", "The device socket path is occupied by an unrelated file."); await unlink(receipt.socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const deviceGate = createDeviceRequestAuthorizer({ grant: () => ({ enabled: !this.stopped && this.receipt?.phase === "active", hostname: receipt.hostname, httpsPort: receipt.httpsPort, deviceIds: this.receipt?.deviceIds ?? [], publicFunnel: this.receipt?.publicFunnel ?? false }), whois: async (ip) => JSON.parse(await this.runner(["whois", "--json", ip])) });
  const limiter = new McpRateLimiter({ maxRequests: 120, windowMs: 60_000 });
  const check = async (request: Request, initial = false) => {
   if (!["/", "/mcp", "/mcp/"].includes(new URL(request.url).pathname)) return false;
   const token = request.headers.get("authorization")?.slice(7) ?? "";
   if (initial && !limiter.check(createHash("sha256").update(token).digest("hex"), "local", "gateway").allowed) return false;
   return await authorizePersonalAccessToken(this.engine.store!, token, "read", "local") && await deviceGate(request);
  };
  this.server = serveMcpHttp(this.engine.config, { unix: receipt.socket, token: randomBytes(32).toString("hex"), scopes: ["read"], catalogOnly: true, operationRegistry: this.registry(receipt), allowedHosts: ["localhost"], allowedOrigins: [], maxBodyBytes: 1_048_576,
   principalForToken: (token) => identifyPersonalAccessToken(this.engine.store!, token),
   authorizeToken: (token, scope, tenantId) => tenantId === "local" ? authorizePersonalAccessToken(this.engine.store!, token, scope, "local") : Promise.resolve(false),
   authorizeRequest: (request) => check(request, true), authorizeResponse: check,
  });
  await chmod(receipt.socket, 0o600);
 }
 async enable(input: DeviceSettings) {
  return this.serialize(async () => {
   this.failure = null;
   // Revoke the old in-memory grant before any installation or permission update.
   await this.stopGateway();
   try { this.receipt = await this.installation.enable(input, (receipt) => this.startGateway(receipt)); return this.status(); }
   catch (error) { await this.stopGateway(); this.recordFailure(error); throw error; }
  });
 }
 async disable(previewOnly = false) {
  return this.serialize(async () => {
   if (previewOnly) return this.installation.disable(true);
   await this.stopGateway(); this.failure = null;
   try { return await this.installation.disable(); } catch (error) { this.recordFailure(error); throw error; }
  });
 }
 private recordFailure(error: unknown) {
  const value = error as Partial<DeviceAccessError>;
  this.failure = { code: typeof value.code === "string" ? value.code : "device_access_failed", message: error instanceof Error ? error.message : "Device access failed.", retryable: value.retryable === true, suggestedFix: value.suggestedFix ?? "Inspect devices status and retry from the owner CLI." };
 }
 async restore() {
  try {
   const receipt = await this.installation.receipt();
   if (!receipt || receipt.phase === "disabled") return;
   if (receipt.phase === "active" && !(await this.installation.status()).owned) throw new DeviceAccessError("device_configuration_conflict", "The saved device listener was edited or removed. Remote access remains disabled.");
   const { deviceIds, visibility, write, httpsPort, publicFunnel } = receipt;
   await this.enable({ deviceIds, visibility, write, httpsPort, publicFunnel });
  } catch (error) { await this.stopGateway(); this.recordFailure(error); }
 }
 async status() {
  try { return { ...await this.installation.status(), running: !!this.server && this.receipt?.phase === "active" && !this.stopped, error: this.failure }; }
  catch (error) { this.recordFailure(error); return { installed: null, owned: false, running: false, receipt: this.receipt ?? null, error: this.failure }; }
 }
 register(registry: OperationRegistry) {
  const empty = { type: "object", properties: {}, additionalProperties: false };
  const settings = { type: "object", required: ["deviceIds"], additionalProperties: false, properties: { deviceIds: { type: "array", items: { type: "string" } }, visibility: { type: "array", items: { type: "string" } }, write: { type: "boolean" }, httpsPort: { type: "integer", minimum: 1, maximum: 65535 }, publicFunnel: { type: "boolean" } } };
  for (const [name, schema, action] of [
   ["peers", empty, () => this.installation.peers()], ["status", empty, () => this.status()], ["preview", settings, (input: unknown) => this.installation.preview(input as DeviceSettings).then(({ configuration: _configuration, ...preview }) => preview)], ["enable", settings, (input: unknown) => this.enable(input as DeviceSettings)], ["disable", { type: "object", additionalProperties: false, properties: { preview: { type: "boolean" } } }, (input: unknown) => this.disable((input as { preview?: boolean }).preview)],
  ] as const) registry.register({ name: "devices." + name, description: "Owner administration of optional Tailscale device access: " + name, requiredScope: "admin", trustBoundary: "local-only", inputSchema: schema, outputSchema: { type: "object" }, execute: async (context, input) => {
   if (context.tenantId && context.tenantId !== "local" || context.allowedAccessLabels !== undefined || context.brainId && context.brainId !== this.installation.brainId) throw new DeviceAccessError("owner_access_required", "Device administration requires unrestricted local owner authority.");
   return action(input);
  } });
 }
 async close() { this.stopped = true; this.epoch++; this.receipt = undefined; await this.pending; await this.stopGateway(); }
}
