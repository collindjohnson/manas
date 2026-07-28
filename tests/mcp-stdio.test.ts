import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { advertisedTools } from "../src/mcp/server";
import { createFullOperationRegistry } from "../src/brain/operation-catalog";

describe("stdio MCP shared catalog", () => {
	test("advertises the same generated operations and boundaries as the registry", () => {
		const registry = createFullOperationRegistry({ repository: {} as never });
		const tools = advertisedTools(registry);
		const retrieval = tools.find((tool) => tool.name === "retrieval.search");
		const skills = tools.find((tool) => tool.name === "skills.list");
		expect(retrieval).toMatchObject({ _meta: { requiredScope: "read", trustBoundary: "remote-safe" } });
		expect(skills).toMatchObject({ _meta: { requiredScope: "read", trustBoundary: "remote-safe" } });
		expect(tools.some((tool) => tool.name === "schema.upgrade.apply")).toBe(true);
		const advertisedNames = new Set(tools.map((tool) => String(tool.name)));
		expect(registry.list().filter((definition) => definition.trustBoundary === "remote-safe").every((definition) => advertisedNames.has(definition.name))).toBe(true);
	});

	test("implements JSON-RPC parse, notification, lifecycle, and method errors", async () => {
		const responses = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
			const child = spawn(process.execPath, ["src/cli.ts", "serve"], { cwd: process.cwd(), env: process.env });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
			child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
			child.once("error", reject);
			child.once("close", (code) => {
				if (code !== 0) { reject(new Error(`stdio MCP exited with ${code}: ${stderr}`)); return; }
				try { resolve(stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)); } catch (error) { reject(error); }
			});
			child.stdin.end(["not-json", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { jsonrpc: "2.0", id: 3, method: "unknown/method" }].map((request) => typeof request === "string" ? request : JSON.stringify(request)).join("\n").concat("\n"));
		});
		expect(responses).toHaveLength(4);
		expect(responses[0]).toMatchObject({ id: null, error: { code: -32700 } });
		expect(responses[1]).toMatchObject({ id: 1, result: { protocolVersion: "2024-11-05" } });
		expect(responses[2]).toMatchObject({ id: 2, result: { tools: expect.any(Array) } });
		expect(responses[3]).toMatchObject({ id: 3, error: { code: -32601 } });
	});

	test("cancels an in-flight stdio operation with the JSON-RPC cancellation code", async () => {
		const script = `
			const { serveMcp } = await import("./src/mcp/server.ts");
			const { OperationRegistry } = await import("./src/brain/operation-registry.ts");
			const registry = new OperationRegistry();
			registry.register({ name: "slow", description: "slow", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: { type: "object" }, requiredScope: "read", trustBoundary: "remote-safe", execute: (context) => new Promise((resolve, reject) => { if (context.signal?.aborted) reject(new Error("aborted")); else context.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); void resolve; }) });
			await serveMcp({}, { operationRegistry: registry });
		`;
		const child = spawn(process.execPath, ["-e", script], { cwd: process.cwd() });
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
		await Bun.sleep(10);
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "slow-1", method: "tools/call", params: { name: "slow", arguments: {} } }) + "\n");
		await Bun.sleep(10);
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow-1" } }) + "\n");
		child.stdin.end();
		await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`stdio cancellation exited with ${code}`))); });
		const responses = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(responses).toContainEqual(expect.objectContaining({ id: "slow-1", error: { code: -32800, message: "request cancelled" } }));
	});
});
