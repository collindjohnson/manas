export interface McpHttpClientOptions {
	initialize?: boolean;
	sessionId?: string;
	protocolVersion?: string;
	requestId?: string | number;
	signal?: AbortSignal;
}

type RpcResponse = { error?: unknown; result?: { content?: Array<{ type?: string; text?: string }> } };

async function rpcRequest(endpoint: URL, token: string, body: Record<string, unknown>, request: typeof fetch, sessionId?: string, signal?: AbortSignal): Promise<{ response: Response; body: RpcResponse }> {
	const headers = new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json" });
	if (sessionId) headers.set("mcp-session-id", sessionId);
	const response = await request(endpoint, { method: "POST", headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
	if (response.status === 202) return { response, body: {} };
	let parsed: RpcResponse;
	try { parsed = await response.json() as RpcResponse; } catch { throw new Error("remote MCP request failed"); }
	return { response, body: parsed };
}

async function notifyCancellation(endpoint: URL, token: string, requestId: string | number, request: typeof fetch, sessionId: string): Promise<void> {
	await rpcRequest(endpoint, token, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } }, request, sessionId);
}

export async function callMcpHttp(
	url: string,
	token: string,
	name: string,
	arguments_: Record<string, unknown>,
	request: typeof fetch = fetch,
	options: McpHttpClientOptions = {},
): Promise<unknown> {
	let endpoint: URL;
	try { endpoint = new URL(url); } catch { throw new Error("invalid MCP URL"); }
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("invalid MCP URL");
	if (!token || token.length < 16) throw new Error("MCP token must be at least 16 characters");
	if (options.initialize && options.sessionId) throw new Error("MCP session cannot be initialized and supplied together");
	let sessionId = options.sessionId;
	if (options.initialize) {
		const initialized = await rpcRequest(endpoint, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: options.protocolVersion ?? "2024-11-05" } }, request, undefined, options.signal);
		if (!initialized.response.ok || initialized.body.error || initialized.body.result === undefined) throw new Error("remote MCP session initialization failed");
		sessionId = initialized.response.headers.get("mcp-session-id") ?? undefined;
		if (!sessionId) throw new Error("remote MCP session initialization failed");
	}
	const requestId = options.requestId ?? (options.initialize ? 2 : 1);
	let cancellationHandler: (() => void) | undefined;
	if (options.signal?.aborted) throw new Error("remote MCP request was cancelled");
	if (options.signal && sessionId) {
		cancellationHandler = () => { void notifyCancellation(endpoint, token, requestId, request, sessionId!).catch(() => undefined); };
		options.signal.addEventListener("abort", cancellationHandler, { once: true });
	}
	let call: Awaited<ReturnType<typeof rpcRequest>>;
	try {
		call = await rpcRequest(endpoint, token, { jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: arguments_ } }, request, sessionId, options.signal);
	} finally {
		if (options.signal && cancellationHandler) options.signal.removeEventListener("abort", cancellationHandler);
	}
	if (!call.response.ok || call.body.error || !call.body.result?.content?.length || call.body.result.content[0]?.type !== "text" || typeof call.body.result.content[0].text !== "string") throw new Error("remote MCP request failed");
	try { return JSON.parse(call.body.result.content[0].text); } catch { throw new Error("remote MCP returned invalid content"); }
}
