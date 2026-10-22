import { expect, test } from "bun:test";
import { OperationRegistry } from "../src/brain/operation-registry";
import { handleMcpHttpRequest } from "../src/mcp/http";

test("catalog-only MCP never advertises or executes legacy fallback operations", async () => {
 const registry = new OperationRegistry();
 registry.register({ name: "allowed", description: "Allowed operation", inputSchema: { type: "object", additionalProperties: false, properties: {} }, outputSchema: {}, requiredScope: "read", trustBoundary: "remote-safe", execute: async () => ({ ok: true }) });
 registry.register({ name: "owner", description: "Owner operation", inputSchema: {}, outputSchema: {}, requiredScope: "admin", trustBoundary: "local-only", execute: async () => { throw new Error("must not execute"); } });
 const call = (name: string) => handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }, registry, { scope: "admin" }, { catalogOnly: true });
 const listed = await handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "tools/list" }, registry, undefined, { catalogOnly: true }) as { tools: Array<{ name: string }> };
 expect(listed.tools.map((tool) => tool.name)).toEqual(["allowed"]);
 expect(await call("allowed")).toEqual({ content: [{ type: "text", text: '{"ok":true}' }] });
 for (const name of ["search", "status", "list_pages", "get_page"]) await expect(call(name)).rejects.toMatchObject({ code: "operation_unavailable" });
 await expect(call("owner")).rejects.toThrow("remote operation is not allowed");
 await expect(handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_pages", arguments: {} } }, undefined, undefined, { catalogOnly: true })).rejects.toMatchObject({ code: "operation_unavailable" });
});

test("private socket MCP applies the request gate before executing catalog operations", async () => {
 const { mkdtemp, rm } = await import("node:fs/promises");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const { serveMcpHttp } = await import("../src/mcp/http");
 const root = await mkdtemp(join(tmpdir(), "manas-gateway-"));
 let executions = 0;
 let mode: "allow" | "deny" | "error" = "deny";
 const registry = new OperationRegistry();
 registry.register({ name: "allowed", description: "Allowed operation", inputSchema: {}, outputSchema: {}, requiredScope: "read", trustBoundary: "remote-safe", execute: async (context) => { expect(context.signal).toBeDefined(); executions++; return {}; } });
 const unix = join(root, "mcp.sock");
 const server = serveMcpHttp({} as never, { unix, maxBodyBytes: 512, token: "0123456789abcdef", catalogOnly: true, operationRegistry: registry, authorizeRequest: async () => { if (mode === "error") throw new Error("identity unavailable"); return mode === "allow"; } });
 const request = (name = "allowed") => fetch("http://localhost/mcp", { unix, method: "POST", headers: { authorization: "Bearer 0123456789abcdef", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) });
 try {
  expect((await request()).status).toBe(403);
  mode = "error";
  expect((await request()).status).toBe(403);
  expect(executions).toBe(0);
  mode = "allow";
  expect((await request()).status).toBe(200);
  expect(executions).toBe(1);
  expect((await (await request("list_pages")).json()).error.data.code).toBe("operation_unavailable");
  expect(executions).toBe(1);
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (let index = 0; index < 4; index++) controller.enqueue(new TextEncoder().encode(" ".repeat(256))); controller.close(); } });
  expect((await fetch("http://localhost/mcp", { unix, method: "POST", headers: { authorization: "Bearer 0123456789abcdef" }, body })).status).toBe(413);
  expect(executions).toBe(1);
 } finally { await server.stop(true); await rm(root, { recursive: true, force: true }); }
});
