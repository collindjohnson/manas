import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "mcp", "client"].join(String.fromCharCode(47));
const { callMcpHttp } = await import(modulePath);

describe("HTTP MCP thin client", () => {
	test("sends authenticated tool calls and unwraps structured text content", async () => {
		let request: Request | undefined;
		const result = await callMcpHttp("http://127.0.0.1:3010", "0123456789abcdef", "brain_status", {}, async (input: RequestInfo | URL, init?: RequestInit) => {
			request = new Request(input, init);
			return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ head: "abc" }) }] } });
		});
		expect(result).toEqual({ head: "abc" });
		expect(request?.headers.get("authorization")).toBe("Bearer 0123456789abcdef");
		expect(await request?.json()).toMatchObject({ method: "tools/call", params: { name: "brain_status" } });
	});

	test("initializes an authenticated session when requested", async () => {
		const requests: Array<{ body: { method: string }; session?: string }> = [];
		const result = await callMcpHttp("http://127.0.0.1:3010", "0123456789abcdef", "skills.list", {}, async (_input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const body = JSON.parse(String(init?.body)) as { method: string };
			requests.push({ body, session: headers.get("mcp-session-id") ?? undefined });
			if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" } });
			return Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] } });
		}, { initialize: true });
		expect(result).toEqual({ ok: true });
		expect(requests.map(({ body, session }) => ({ method: body.method, session }))).toEqual([{ method: "initialize", session: undefined }, { method: "tools/call", session: "session-1" }]);
	});

	test("rejects unsafe endpoints and malformed remote responses", async () => {
		await expect(callMcpHttp("file:///tmp/brain", "0123456789abcdef", "brain_status", {})).rejects.toThrow("invalid MCP URL");
		await expect(callMcpHttp("http://127.0.0.1:3010", "0123456789abcdef", "brain_status", {}, async () => Response.json({ result: {} }))).rejects.toThrow("remote MCP request failed");
	});

	test("sends protocol cancellation when a session call is aborted", async () => {
		const controller = new AbortController();
		const requests: Array<{ method: string; requestId?: string | number }> = [];
		let callStarted!: () => void;
		const started = new Promise<void>((resolve) => { callStarted = resolve; });
		const request = async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { method: string; params?: { requestId?: string | number } };
			requests.push({ method: body.method, requestId: body.params?.requestId });
			if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" } });
			if (body.method === "notifications/cancelled") return new Response(null, { status: 202 });
			callStarted();
			return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
		};
		const pending = callMcpHttp("http://127.0.0.1:3010", "0123456789abcdef", "slow", {}, request, { initialize: true, requestId: "slow-1", signal: controller.signal });
		await started;
		controller.abort();
		await expect(pending).rejects.toThrow();
		await Bun.sleep(0);
		expect(requests).toContainEqual({ method: "notifications/cancelled", requestId: "slow-1" });
	});
});
