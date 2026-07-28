import { describe, expect, test } from "bun:test";
import { createZeroEntropyClient } from "../src/brain/zeroentropy";

describe("ZeroEntropy client", () => {
	test("authenticates and maps deterministic chunk documents", async () => {
		const calls: Array<{ path: string; body: unknown }> = [];
		const client = createZeroEntropyClient({
			baseUrl: "https://zeroentropy.test/v1/",
			collection: "vault",
			apiKey: "secret",
			timeoutMs: 1000,
			fetch: async (input, init) => {
				expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
				const body = init?.body;
				if (typeof body !== "string")
					throw new Error("expected JSON request body");
				try {
					calls.push({ path: String(input), body: JSON.parse(body) });
				} catch {
					throw new Error("expected valid JSON request body");
				}
				return Response.json({ message: "Success!" });
			},
		});
		await client.upsert([
			{
				id: "chunk-id",
				text: "private transcript",
				metadata: { provider: "codex" },
			},
		]);
		expect(calls).toEqual([
			{
				path: "https://zeroentropy.test/v1/documents/add-document",
				body: {
					collection_name: "vault",
					path: "chunk-id",
					content: { type: "text", text: "private transcript" },
					metadata: { provider: "codex" },
				},
			},
		]);
	});

	test("redacts error response bodies", async () => {
		const client = createZeroEntropyClient({
			baseUrl: "https://zeroentropy.test/v1",
			collection: "vault",
			apiKey: "secret",
			timeoutMs: 1000,
			fetch: async () => new Response("private transcript", { status: 401 }),
		});
		expect(client.search("private query", 1)).rejects.toThrow(
			"authentication failed",
		);
	});

	test("caps retry-after delays and retries network failures", async () => {
		let attempts = 0;
		const delays: number[] = [];
		const client = createZeroEntropyClient({
			baseUrl: "https://zeroentropy.test/v1",
			collection: "vault",
			apiKey: "secret",
			timeoutMs: 1000,
			retryAttempts: 2,
			fetch: async () => {
				attempts++;
				if (attempts === 1)
					return new Response(null, {
						status: 429,
						headers: { "retry-after": "999999" },
					});
				return Response.json({ results: [] });
			},
			sleep: async (milliseconds) => void delays.push(milliseconds),
		});
		await client.search("query", 1);
		expect(attempts).toBe(2);
		expect(delays).toEqual([10_000]);
	});
});
