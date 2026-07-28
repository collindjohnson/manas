import { createHash } from "node:crypto";
import type { OperationAuthorization, OperationContext, OperationDefinition, OperationRegistry } from "../brain/operation-registry";

type Config = Record<string, unknown>;
type Request = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown };
export const MCP_PROTOCOL_VERSION = "2024-11-05";

const serverModule = await import([".", "server"].join(String.fromCharCode(47)));
const { BrainRepository } = await import(["..", "brain", "repository"].join(String.fromCharCode(47)));
const operationsModule = await import(["..", "brain", "operations"].join(String.fromCharCode(47)));
const servicesModule = await import(["..", "brain", "services"].join(String.fromCharCode(47)));
const httpOperationNames = new Set<string>([...operationsModule.brainRepositoryOperationNames, "search", "think", "related", "status", "health"]);
export type McpScope = "read" | "write" | "admin";
export interface McpRateLimit { maxRequests: number; windowMs: number; }
type RateLimitBucket = { count: number; resetAt: number };

export class McpSessionManager {
	private readonly sessions = new Map<string, { protocolVersion: string; createdAt: number; lastSeenAt: number; cancelled: Set<string>; requests: Map<string, AbortController> }>();
	create(protocolVersion = "2024-11-05", now = Date.now()): string {
		const id = crypto.randomUUID();
		this.sessions.set(id, { protocolVersion, createdAt: now, lastSeenAt: now, cancelled: new Set(), requests: new Map() });
		return id;
	}
	require(id: string, protocolVersion = MCP_PROTOCOL_VERSION, now = Date.now()): void {
		const session = this.sessions.get(id);
		if (!session || session.protocolVersion !== protocolVersion) throw new Error("MCP session is invalid");
		session.lastSeenAt = now;
	}
	close(id: string): void { this.sessions.delete(id); }
	cancel(id: string, requestId: string): void {
		const session = this.sessions.get(id);
		if (!session) throw new Error("MCP session is invalid");
		if (!requestId.trim()) throw new Error("MCP request ID is invalid");
		session.cancelled.add(requestId);
		session.requests.get(requestId)?.abort();
	}
	startRequest(id: string, requestId: string): AbortSignal {
		const session = this.sessions.get(id);
		if (!session) throw new Error("MCP session is invalid");
		if (!requestId.trim()) throw new Error("MCP request ID is invalid");
		const controller = new AbortController();
		if (session.cancelled.has(requestId)) controller.abort();
		session.requests.set(requestId, controller);
		return controller.signal;
	}
	finishRequest(id: string, requestId: string): void {
		this.sessions.get(id)?.requests.delete(requestId);
	}
	wasCancelled(id: string, requestId: string): boolean {
		const session = this.sessions.get(id);
		if (!session) throw new Error("MCP session is invalid");
		return session.cancelled.has(requestId);
	}
}

export function validateMcpOrigin(origin: string | null, allowedOrigins = ["http://127.0.0.1", "http://localhost"]): void {
	if (origin !== null && !allowedOrigins.includes(origin)) throw new Error("MCP origin is not allowed");
}

export function validateMcpHost(host: string | null, allowedHosts = ["127.0.0.1", "localhost"]): void {
	if (!host) throw new Error("MCP host is required");
	const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":", 1)[0];
	if (!allowedHosts.includes(hostname)) throw new Error("MCP host is not allowed");
}

export class McpRateLimiter {
	private readonly buckets = new Map<string, RateLimitBucket>();
	constructor(private readonly limit: McpRateLimit) {
		if (!Number.isInteger(limit.maxRequests) || limit.maxRequests < 1 || !Number.isInteger(limit.windowMs) || limit.windowMs < 1) throw new Error("invalid MCP rate limit");
	}
	check(principal: string, tenantId: string, operation: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
		if (!principal || !tenantId || !operation) throw new Error("invalid MCP rate-limit key");
		const key = createHash("sha256").update(`${principal}\0${tenantId}\0${operation}`).digest("hex");
		const bucket = this.buckets.get(key);
		if (!bucket || bucket.resetAt <= now) {
			this.buckets.set(key, { count: 1, resetAt: now + this.limit.windowMs });
			return { allowed: true, retryAfterMs: 0 };
		}
		if (bucket.count >= this.limit.maxRequests) return { allowed: false, retryAfterMs: bucket.resetAt - now };
		bucket.count += 1;
		return { allowed: true, retryAfterMs: 0 };
	}
}
const adminOperations = new Set<string>(["purge_deleted_page"]);
const writeOperations = new Set<string>(["install_schema_pack", "set_schema_pack", "repair_brain", "revert_page", "put_page", "move_page", "delete_page", "restore_page", "set_page_access_labels"]);

export function requiredMcpScope(name: string, registry?: OperationRegistry): McpScope {
	if (registry) {
		try { return registry.get(name).requiredScope; } catch { /* legacy operation */ }
	}
	return adminOperations.has(name) ? "admin" : writeOperations.has(name) ? "write" : "read";
}

export async function isMcpTokenAuthorized(token: string, required: McpScope, options: { token: string; scopes: readonly McpScope[]; tenantId?: string; authorizeToken?: (token: string, scope: McpScope, tenantId?: string) => Promise<boolean> }): Promise<boolean> {
	if (token === options.token) return options.scopes.includes(required);
	return (await options.authorizeToken?.(token, required, options.tenantId)) === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isMcpNotification(request: Pick<Request, "id">): boolean {
	return request.id === undefined;
}

function response(id: Request["id"], result?: unknown, error?: { code: number; message: string }): Response {
	return Response.json(error ? { jsonrpc: "2.0", id: id ?? null, error } : { jsonrpc: "2.0", id, result });
}

function requestedProtocolVersion(request: Request): string {
	if (!isRecord(request.params) || request.params.protocolVersion === undefined) return MCP_PROTOCOL_VERSION;
	if (request.params.protocolVersion !== MCP_PROTOCOL_VERSION) throw new Error("unsupported MCP protocol version");
	return MCP_PROTOCOL_VERSION;
}

function localBrainRepository() {
	const root = process.env.MANAS_BRAIN_REPOSITORY;
	if (!root) throw new Error("brain repository is not configured");
	return new BrainRepository(root);
}

export async function handleMcpHttpRequest(config: Config, request: Request, operationRegistry?: OperationRegistry, operationContext?: Partial<OperationContext>): Promise<unknown> {
	if (request.method === "ping") return {};
	if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return {};
	if (request.method === "initialize") return { protocolVersion: requestedProtocolVersion(request), capabilities: { tools: {} }, serverInfo: { name: "manas", version: "0.1.0" } };
	if (request.method === "tools/list") {
		const legacy = serverModule.registeredTools.filter((tool: { name: string }) => httpOperationNames.has(tool.name)).map((tool: { name: string; description?: string; inputSchema?: unknown }) => ({ ...tool, _meta: { requiredScope: requiredMcpScope(tool.name, operationRegistry) } }));
		const generated = operationRegistry?.list().filter((definition) => definition.trustBoundary !== "local-only").map((definition) => ({ name: definition.name, description: definition.description, inputSchema: definition.inputSchema, _meta: { requiredScope: definition.requiredScope } })) ?? [];
		const byName = new Map([...legacy, ...generated].map((tool) => [tool.name, tool]));
		return { tools: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)) };
	}
	if (request.method !== "tools/call" || !isRecord(request.params) || typeof request.params.name !== "string") throw new Error("invalid params");
	const name = request.params.name;
	const args = request.params.arguments;
	if (!isRecord(args)) throw new Error("invalid params");
	if (operationRegistry) {
		try {
			const definition = operationRegistry.get(name);
			if (definition.trustBoundary === "local-only") throw new Error("remote operation is not allowed");
			const result = await operationRegistry.execute({ scope: operationContext?.scope ?? definition.requiredScope, principal: operationContext?.principal ?? "http", tenantId: operationContext?.tenantId ?? "local", ...(operationContext?.userId ? { userId: operationContext.userId } : {}), ...(operationContext?.brainId ? { brainId: operationContext.brainId } : {}), ...(operationContext?.allowedAccessLabels ? { allowedAccessLabels: operationContext.allowedAccessLabels } : {}), ...(operationContext?.authorize ? { authorize: operationContext.authorize } : {}), ...(operationContext?.signal ? { signal: operationContext.signal } : {}) }, name, args);
			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		} catch (error) {
			if (error instanceof Error && error.message !== "operation is not registered") throw error;
		}
	}
	if (operationsModule.isBrainRepositoryOperation(name)) {
		const requiredScope = requiredMcpScope(name, operationRegistry);
		if (operationContext?.scope) {
			const rank: Record<McpScope, number> = { read: 1, write: 2, admin: 3 };
			if (rank[operationContext.scope] < rank[requiredScope]) throw new Error("operation scope is insufficient");
		}
		await operationContext?.authorize?.({ name, description: `Execute the ${name} contract.`, inputSchema: {}, outputSchema: {}, requiredScope, trustBoundary: "remote-safe", execute: async () => undefined }, args);
		const result = await operationsModule.executeBrainRepositoryOperation(localBrainRepository(), name, args);
		return { content: [{ type: "text", text: JSON.stringify(result) }] };
	}
	if (name === "search") {
		if (typeof args.query !== "string" || !args.query.trim()) throw new Error("invalid params");
		return { content: [{ type: "text", text: JSON.stringify(await servicesModule.searchService(config, args.query, args)) }] };
	}
	if (name === "think") {
		if (typeof args.question !== "string" || !args.question.trim()) throw new Error("invalid params");
		return { content: [{ type: "text", text: JSON.stringify(await servicesModule.thinkService(config, args.question)) }] };
	}
	if (name === "related") {
		if (typeof args.nessieId !== "string") throw new Error("invalid params");
		return { content: [{ type: "text", text: JSON.stringify(await servicesModule.relatedService(config, args.nessieId)) }] };
	}
	if (name === "status") return { content: [{ type: "text", text: JSON.stringify(await servicesModule.statusService(config)) }] };
	if (name === "health") return { content: [{ type: "text", text: JSON.stringify(await servicesModule.healthService(config)) }] };
	throw new Error("invalid params");
}

export function serveMcpHttp(_config: Config, options: { port: number; token: string; scopes?: McpScope[]; authorizeToken?: (token: string, scope: McpScope, tenantId?: string) => Promise<boolean>; authorizeOperation?: (principal: { id: string; tenantId: string; userId?: string }, definition: OperationDefinition, input: Record<string, unknown>) => void | OperationAuthorization | Promise<void | OperationAuthorization>; rateLimit?: McpRateLimit; principalForToken?: (token: string) => { id: string; tenantId?: string; userId?: string } | Promise<{ id: string; tenantId?: string; userId?: string } | undefined> | undefined; maxBodyBytes?: number; allowedOrigins?: string[]; allowedHosts?: string[]; sessions?: McpSessionManager; requireSession?: boolean; oauth?: { handle(request: globalThis.Request): Promise<Response> }; operationRegistry?: OperationRegistry }) {
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error("invalid HTTP MCP port");
	if (!options.token || options.token.length < 16) throw new Error("HTTP MCP token must be at least 16 characters");
	if (options.maxBodyBytes !== undefined && (!Number.isInteger(options.maxBodyBytes) || options.maxBodyBytes < 1)) throw new Error("invalid HTTP MCP body limit");
	const scopes = options.scopes ?? ["read", "write"];
	if (!scopes.length || scopes.some((scope) => scope !== "read" && scope !== "write" && scope !== "admin")) throw new Error("invalid HTTP MCP scopes");
	const limiter = new McpRateLimiter(options.rateLimit ?? { maxRequests: 120, windowMs: 60_000 });
	const sessions = options.sessions ?? new McpSessionManager();
	return Bun.serve({
		hostname: "127.0.0.1",
		port: options.port,
		fetch: async (request) => {
			if (options.oauth && new URL(request.url).pathname.startsWith("/oauth/")) return options.oauth.handle(request);
			if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
			try { validateMcpOrigin(request.headers.get("origin"), options.allowedOrigins); } catch { return new Response("forbidden", { status: 403 }); }
			try { validateMcpHost(request.headers.get("host"), options.allowedHosts); } catch { return new Response("forbidden", { status: 403 }); }
			const contentLength = Number(request.headers.get("content-length") ?? "0");
			if (options.maxBodyBytes !== undefined && Number.isFinite(contentLength) && contentLength > options.maxBodyBytes) return new Response("payload too large", { status: 413 });
			const authorization = request.headers.get("authorization");
			if (!authorization?.startsWith("Bearer ")) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
			const token = authorization.slice("Bearer ".length);
			if (!options.authorizeToken && token !== options.token) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
			let body: unknown;
			try {
				const bodyText = await request.text();
				if (options.maxBodyBytes !== undefined && new TextEncoder().encode(bodyText).byteLength > options.maxBodyBytes) return new Response("payload too large", { status: 413 });
				body = JSON.parse(bodyText);
			} catch { return response(null, undefined, { code: -32700, message: "parse error" }); }
			if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") return response(null, undefined, { code: -32600, message: "invalid request" });
			const rpc = body as Request;
			const sessionId = request.headers.get("mcp-session-id");
			if (options.requireSession && rpc.method !== "initialize") {
				if (!sessionId) return response(rpc.id, undefined, { code: -32000, message: "MCP session is required" });
				try { sessions.require(sessionId); } catch { return response(rpc.id, undefined, { code: -32000, message: "MCP session is invalid" }); }
			}
			if (options.requireSession && rpc.method === "notifications/cancelled") {
				if (!sessionId || !isRecord(rpc.params) || (typeof rpc.params.requestId !== "string" && typeof rpc.params.requestId !== "number")) return response(rpc.id, undefined, { code: -32602, message: "invalid params" });
				sessions.cancel(sessionId, String(rpc.params.requestId));
				return new Response(null, { status: 202 });
			}
			const required = rpc.method === "tools/call" && isRecord(rpc.params) && typeof rpc.params.name === "string" ? requiredMcpScope(rpc.params.name, options.operationRegistry) : "read";
			const principal = await options.principalForToken?.(token) ?? { id: token, tenantId: "local" };
			const allowed = await isMcpTokenAuthorized(token, required, { token: options.token, scopes, tenantId: principal.tenantId, authorizeToken: options.authorizeToken });
			if (!allowed) return response(rpc.id, undefined, { code: -32603, message: "forbidden" });
			const rate = limiter.check(principal.id, principal.tenantId ?? "local", rpc.method === "tools/call" && isRecord(rpc.params) && typeof rpc.params.name === "string" ? rpc.params.name : rpc.method);
			if (!rate.allowed) return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32029, message: "rate limit exceeded" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(Math.ceil(rate.retryAfterMs / 1_000)) } });
			let startedRequest = false;
			let requestId: string | undefined;
			try {
				const principalContext = { id: principal.id, tenantId: principal.tenantId ?? "local", ...(principal.userId ? { userId: principal.userId } : {}) };
				const authorize = options.authorizeOperation ? (definition: OperationDefinition, input: Record<string, unknown>) => options.authorizeOperation!(principalContext, definition, input) : undefined;
				requestId = rpc.id === undefined || rpc.id === null ? undefined : String(rpc.id);
				if (options.requireSession && sessionId && requestId && sessions.wasCancelled(sessionId, requestId)) return response(rpc.id, undefined, { code: -32800, message: "request cancelled" });
				const signal = options.requireSession && sessionId && requestId ? sessions.startRequest(sessionId, requestId) : undefined;
				startedRequest = Boolean(signal);
				const result = await handleMcpHttpRequest(_config, rpc, options.operationRegistry, { scope: required, principal: principal.id, tenantId: principal.tenantId ?? "local", ...(principal.userId ? { userId: principal.userId } : {}), ...(authorize ? { authorize } : {}), ...(signal ? { signal } : {}) });
				if (isMcpNotification(rpc)) return new Response(null, { status: 202 });
				if (options.requireSession && sessionId && requestId && sessions.wasCancelled(sessionId, requestId)) return response(rpc.id, undefined, { code: -32800, message: "request cancelled" });
				const output = response(rpc.id, result);
				if (options.requireSession && rpc.method === "initialize") {
					const id = sessions.create(MCP_PROTOCOL_VERSION);
					const headers = new Headers(output.headers);
					headers.set("mcp-session-id", id);
					return new Response(output.body, { status: output.status, headers });
				}
				return output;
			}
			catch (error) {
				if (options.requireSession && sessionId && rpc.id !== undefined && rpc.id !== null && sessions.wasCancelled(sessionId, String(rpc.id))) return response(rpc.id, undefined, { code: -32800, message: "request cancelled" });
				const message = error instanceof Error ? error.message : "internal error";
				return response(rpc.id, undefined, { code: message === "invalid params" ? -32602 : -32603, message: message === "invalid params" ? message : "internal error" });
			}
			finally {
				if (options.requireSession && sessionId && requestId && startedRequest) sessions.finishRequest(sessionId, requestId);
			}
		},
	});
}
