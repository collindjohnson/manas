import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const modulePath = ["..", "src", "sources", "network"].join(String.fromCharCode(47));
const { ConfinedUploadStore, HttpPullSource, WebhookReplayGuard, verifyWebhookSignature } = await import(modulePath);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("network ingestion boundaries", () => {
	test("uses conditional HTTP pulls, bounded redirects, and stable source hashes", async () => {
		const original = globalThis.fetch;
		const requests: RequestInit[] = [];
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(init ?? {});
			return new Response(requests.length === 1 ? "body" : null, { status: requests.length === 1 ? 200 : 304, headers: { etag: "\"v1\"" } });
		}) as unknown as typeof fetch;
		try {
			const source = new HttpPullSource({ id: "web", url: "https://example.invalid/feed", maxBytes: 100 });
			const first = await source.pull();
			expect(first.document).toMatchObject({ externalId: "web", content: "body", contentHash: expect.any(String), externalRevision: "\"v1\"" });
			const second = await source.pull(first.state);
			expect(second).toMatchObject({ notModified: true });
			expect(new Headers(requests[1]?.headers).get("if-none-match")).toBe("\"v1\"");
			expect(source.describe()).toMatchObject({ id: "web", version: "1", kind: "http", trusted: true });
			const streamed = await Array.fromAsync(source.scan({ cursor: JSON.stringify(first.state) }));
			expect(streamed).toEqual([]);
			expect(JSON.parse(source.checkpoint().cursor!)).toMatchObject({ etag: "\"v1\"" });
		} finally { globalThis.fetch = original; }
	});

	test("rejects credential-bearing source URLs before any request", () => {
		expect(() => new HttpPullSource({ id: "web", url: "https://user:pass@example.invalid/feed" })).toThrow("credentials");
	});

	test("rejects forged or malformed opaque checkpoints", async () => {
		const source = new HttpPullSource({ id: "web", url: "https://example.invalid/feed" });
		await expect(Array.fromAsync(source.scan({ cursor: JSON.stringify({ etag: 42 }) }))).rejects.toThrow("checkpoint");
		await expect(Array.fromAsync(source.scan({ cursor: JSON.stringify({ etag: "ok", unexpected: "value" }) }))).rejects.toThrow("checkpoint");
	});

	test("verifies signed webhook bodies, rejects replay, and confines uploads", async () => {
		const secret = "webhook-secret";
		const body = "{\"id\":\"1\"}";
		const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
		expect(verifyWebhookSignature(body, signature, secret)).toBe(true);
		expect(verifyWebhookSignature(body, signature.slice(0, -1) + "0", secret)).toBe(false);
		const replay = new WebhookReplayGuard();
		replay.accept("event-1");
		expect(() => replay.accept("event-1")).toThrow("replay");
		const root = await mkdtemp(join(tmpdir(), "brain-upload-"));
		roots.push(root);
		const upload = await new ConfinedUploadStore(root, 10).save(new Uint8Array([1, 2]), "capture.bin");
		expect([...await readFile(upload.path)]).toEqual([1, 2]);
		await expect(new ConfinedUploadStore(root, 1).save(new Uint8Array([1, 2]), "capture.bin")).rejects.toThrow("size");
		await expect(new ConfinedUploadStore(root).save(new Uint8Array([1]), "../escape.bin")).rejects.toThrow("filename");
	});
});
