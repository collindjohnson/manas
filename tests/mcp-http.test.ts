import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { createFullOperationRegistry } from "../src/brain/operation-catalog";

const modulePath = ["..", "src", "mcp", "http"].join(String.fromCharCode(47));
const { handleMcpHttpRequest, isMcpTokenAuthorized, isMcpNotification, McpRateLimiter, McpSessionManager, requiredMcpScope, serveMcpHttp, validateMcpHost, validateMcpOrigin, MCP_PROTOCOL_VERSION } = await import(modulePath);
const repositoryModule = ["..", "src", "brain", "repository"].join(String.fromCharCode(47));
const { BrainRepository } = await import(repositoryModule);
const execFile = promisify(execFileCallback);

describe("HTTP MCP", () => {
	test("requires an explicit non-trivial bearer token before binding", () => {
		expect(() => serveMcpHttp({}, { port: 1, token: "short" })).toThrow("at least 16 characters");
		expect(() => serveMcpHttp({}, { port: -1, token: "0123456789abcdef" })).toThrow("invalid HTTP MCP port");
		expect(() => serveMcpHttp({}, { port: 1, token: "0123456789abcdef", scopes: [] })).toThrow("invalid HTTP MCP scopes");
		expect(() => serveMcpHttp({}, { port: 1, token: "0123456789abcdef", maxBodyBytes: 0 })).toThrow("body limit");
	});

	test("enforces origin policy and session lifecycle", () => {
		expect(() => validateMcpOrigin("https://evil.invalid")).toThrow("origin");
		expect(() => validateMcpOrigin("http://localhost")).not.toThrow();
		expect(() => validateMcpHost("localhost:3000")).not.toThrow();
		expect(() => validateMcpHost("evil.invalid")).toThrow("host");
		const sessions = new McpSessionManager();
		const id = sessions.create();
		expect(() => sessions.require(id)).not.toThrow();
		expect(() => sessions.require("missing")).toThrow("session");
		sessions.close(id);
		expect(() => sessions.require(id)).toThrow("session");
	});

	test("tracks request cancellation within a validated session", () => {
		const sessions = new McpSessionManager();
		const id = sessions.create();
		const signal = sessions.startRequest(id, "41");
		expect(signal.aborted).toBe(false);
		expect(sessions.wasCancelled(id, "42")).toBe(false);
		sessions.cancel(id, "42");
		expect(sessions.wasCancelled(id, "42")).toBe(true);
		sessions.cancel(id, "41");
		expect(signal.aborted).toBe(true);
		sessions.finishRequest(id, "41");
		expect(() => sessions.cancel(id, "")).toThrow("request ID");
	});

	test("supports protocol negotiation and suppresses HTTP notifications", async () => {
		expect(isMcpNotification({ id: undefined })).toBe(true);
		expect(isMcpNotification({ id: 1 })).toBe(false);
		expect(await handleMcpHttpRequest({}, { jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({});
		expect(await handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION } })).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION });
		await expect(handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } })).rejects.toThrow("unsupported MCP protocol version");
	});

	test("advertises only operations supported by the HTTP transport", async () => {
		const result = await handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "tools/list" }) as { tools: Array<{ name: string }> };
		expect(result.tools.some((tool) => tool.name === "search")).toBe(true);
		expect(result.tools.some((tool) => tool.name === "sources_sync")).toBe(false);
		expect(requiredMcpScope("get_page")).toBe("read");
		expect(requiredMcpScope("put_page")).toBe("write");
		expect(requiredMcpScope("install_schema_pack")).toBe("write");
		expect(requiredMcpScope("purge_deleted_page")).toBe("admin");
	});

	test("enforces static and delegated token scopes before execution", async () => {
		const options = { token: "0123456789abcdef", scopes: ["read"] as const, authorizeToken: async (token: string, scope: string) => token === "pat" && scope === "write" };
		expect(await isMcpTokenAuthorized("0123456789abcdef", "read", options)).toBe(true);
		expect(await isMcpTokenAuthorized("0123456789abcdef", "write", options)).toBe(false);
		expect(await isMcpTokenAuthorized("pat", "write", options)).toBe(true);
		expect(await isMcpTokenAuthorized("pat", "read", options)).toBe(false);
	});

	test("passes the resolved tenant into delegated token authorization", async () => {
		let tenantSeen: string | undefined;
		const allowed = await isMcpTokenAuthorized("pat", "read", { token: "0123456789abcdef", scopes: ["read"], tenantId: "tenant-b", authorizeToken: async (_token: string, _scope: "read" | "write" | "admin", tenantId?: string) => { tenantSeen = tenantId; return tenantId === "tenant-b"; } });
		expect(allowed).toBe(true);
		expect(tenantSeen).toBe("tenant-b");
	});

	test("rate limits each principal, tenant, and operation independently", () => {
		const limiter = new McpRateLimiter({ maxRequests: 2, windowMs: 1_000 });
		expect(limiter.check("a", "tenant-a", "search", 0)).toMatchObject({ allowed: true });
		expect(limiter.check("a", "tenant-a", "search", 1)).toMatchObject({ allowed: true });
		expect(limiter.check("a", "tenant-a", "search", 2)).toMatchObject({ allowed: false, retryAfterMs: 998 });
		expect(limiter.check("a", "tenant-a", "status", 2)).toMatchObject({ allowed: true });
		expect(limiter.check("a", "tenant-b", "search", 2)).toMatchObject({ allowed: true });
		expect(limiter.check("a", "tenant-a", "search", 1_000)).toMatchObject({ allowed: true });
	});

	test("executes shared compare-and-swap page operations without local client paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-mcp-http-"));
		const previous = process.env.MANAS_BRAIN_REPOSITORY;
		try {
			const repository = new BrainRepository(join(root, "brain"));
			await repository.initialize();
			await execFile("git", ["-C", repository.root, "config", "user.name", "Test"]);
			await execFile("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
			process.env.MANAS_BRAIN_REPOSITORY = repository.root;
			const result = await handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "put_page", arguments: { path: "notes/remote.md", content: "remote", expectedHead: null } } }) as { content: Array<{ text: string }> };
			expect(JSON.parse(result.content[0]!.text)).toMatchObject({ path: "notes/remote.md", content: "remote" });
		} finally {
			if (previous === undefined) delete process.env.MANAS_BRAIN_REPOSITORY;
			else process.env.MANAS_BRAIN_REPOSITORY = previous;
			await rm(root, { recursive: true, force: true });
		}
	});

	test("applies scope and delegated authorization to legacy brain operations", async () => {
		await expect(handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "put_page", arguments: { path: "notes/blocked.md", content: "blocked", expectedHead: null } } }, undefined, { scope: "read", principal: "reader" })).rejects.toThrow("scope");
		const root = await mkdtemp(join(tmpdir(), "brain-mcp-http-auth-"));
		const previous = process.env.MANAS_BRAIN_REPOSITORY;
		try {
			const repository = new BrainRepository(join(root, "brain"));
			await repository.initialize();
			await execFile("git", ["-C", repository.root, "config", "user.name", "Test"]);
			await execFile("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
			process.env.MANAS_BRAIN_REPOSITORY = repository.root;
			let authorized = false;
			await expect(handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "put_page", arguments: { path: "notes/blocked.md", content: "blocked", expectedHead: null } } }, undefined, { scope: "write", principal: "writer", authorize: (definition: { name: string }) => { authorized = definition.name === "put_page"; throw new Error("brain membership denied"); } })).rejects.toThrow("brain membership denied");
			expect(authorized).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.MANAS_BRAIN_REPOSITORY;
			else process.env.MANAS_BRAIN_REPOSITORY = previous;
			await rm(root, { recursive: true, force: true });
		}
	});

	test("serves the shared remote-safe catalog through the HTTP transport handler", async () => {
		const registry = createFullOperationRegistry({ repository: {} as never });
		const response = await handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "skills.list", arguments: {} } }, registry, { scope: "read", principal: "http-test", tenantId: "tenant-a" }) as { content: Array<{ text: string }> };
		expect(JSON.parse(response.content[0]!.text)).toHaveLength(5);
		const anomaly = await handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "analysis.anomaly", arguments: { records: [{ id: "metric", tenantId: "tenant-a", brainId: "brain-a", baseline: 1, observed: 4, threshold: 1 }] } } }, registry, { scope: "read", principal: "http-test", tenantId: "tenant-a" }) as { content: Array<{ text: string }> };
		expect(JSON.parse(anomaly.content[0]!.text)).toMatchObject([{ id: "metric", severity: "critical" }]);
		const listed = await handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, registry) as { tools: Array<{ name: string }> };
		expect(listed.tools.some((tool) => tool.name === "skills.list")).toBe(true);
		expect(listed.tools.some((tool) => tool.name === "schema.upgrade.apply")).toBe(false);
		const httpNames = new Set(listed.tools.map((tool) => tool.name));
			expect(registry.list().filter((definition) => definition.trustBoundary === "remote-safe").every((definition) => httpNames.has(definition.name))).toBe(true);
			expect(httpNames.has("jobs.enqueue")).toBe(false);
			await expect(handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "jobs.enqueue", arguments: { type: "indexing", payload: { repositoryRoot: "/private" } } } }, registry, { scope: "write", principal: "http-test", tenantId: "tenant-a" })).rejects.toThrow("remote operation is not allowed");
		await expect(handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "skills.list", arguments: {} } }, registry, { scope: "read", principal: "http-test", tenantId: "tenant-a", authorize: (definition: { name: string }) => { if (definition.name === "skills.list") throw new Error("brain membership denied"); } })).rejects.toThrow("brain membership denied");
	});
});
