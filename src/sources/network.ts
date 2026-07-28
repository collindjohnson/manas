import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { basename, extname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { NormalizedDocument, SourceCheckpoint, SourceDescriptor } from "./types";

export interface HttpPullState { etag?: string; lastModified?: string; externalRevision?: string; }
export interface HttpPullResult { document?: NormalizedDocument; state: HttpPullState; notModified: boolean; }

function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function parseHttpPullState(value: unknown): HttpPullState {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid HTTP source checkpoint");
	const record = value as Record<string, unknown>;
	const allowed = new Set(["etag", "lastModified", "externalRevision"]);
	if (Object.keys(record).some((key) => !allowed.has(key)) || Object.values(record).some((item) => item !== undefined && typeof item !== "string")) throw new Error("invalid HTTP source checkpoint");
	return {
		...(typeof record.etag === "string" ? { etag: record.etag } : {}),
		...(typeof record.lastModified === "string" ? { lastModified: record.lastModified } : {}),
		...(typeof record.externalRevision === "string" ? { externalRevision: record.externalRevision } : {}),
	};
}

function validUrl(value: string): URL {
	let url: URL;
	try { url = new URL(value); } catch { throw new Error("invalid source URL"); }
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("source URL must use HTTP or HTTPS");
	if (url.username || url.password) throw new Error("source URL must not contain credentials");
	return url;
}

export class HttpPullSource {
	readonly id: string;
	private readonly url: URL;
	constructor(options: { id: string; url: string; maxBytes?: number; timeoutMs?: number; headers?: Record<string, string>; maxRedirects?: number }) {
		if (!options.id.trim()) throw new Error("invalid HTTP source id");
		this.id = options.id;
		this.url = validUrl(options.url);
		this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.headers = { ...(options.headers ?? {}) };
		this.maxRedirects = options.maxRedirects ?? 3;
		if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1 || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || !Number.isInteger(this.maxRedirects) || this.maxRedirects < 0 || this.maxRedirects > 10) throw new Error("invalid HTTP source limits");
	}
	private readonly maxBytes: number;
	private readonly timeoutMs: number;
	private readonly headers: Record<string, string>;
	private readonly maxRedirects: number;
	private latestState: HttpPullState = {};

	describe(): SourceDescriptor { return { id: this.id, version: "1", kind: "http", trusted: true }; }

	async *scan(checkpoint?: SourceCheckpoint): AsyncIterable<NormalizedDocument> {
		let state = this.latestState;
		if (checkpoint?.cursor) {
			try {
				state = parseHttpPullState(JSON.parse(checkpoint.cursor) as unknown);
			} catch { throw new Error("invalid HTTP source checkpoint"); }
		}
		const result = await this.pull(state);
		this.latestState = result.state;
		if (result.document) yield result.document;
	}

	checkpoint(): SourceCheckpoint { return { updatedAt: new Date().toISOString(), cursor: JSON.stringify(this.latestState) }; }

	async pull(state: HttpPullState = {}): Promise<HttpPullResult> {
		let url = this.url;
		let response: Response | undefined;
		for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), this.timeoutMs);
			try {
				response = await fetch(url, { headers: { ...this.headers, ...(state.etag ? { "if-none-match": state.etag } : {}), ...(state.lastModified ? { "if-modified-since": state.lastModified } : {}) }, redirect: "manual", signal: controller.signal });
			} finally { clearTimeout(timer); }
			if (![301, 302, 303, 307, 308].includes(response.status)) break;
			const location = response.headers.get("location");
			if (!location || redirect === this.maxRedirects) throw new Error("HTTP source redirect limit exceeded");
			url = validUrl(new URL(location, url).toString());
		}
		if (!response) throw new Error("HTTP source request failed");
		const nextState = { etag: response.headers.get("etag") ?? state.etag, lastModified: response.headers.get("last-modified") ?? state.lastModified, externalRevision: response.headers.get("etag") ?? response.headers.get("last-modified") ?? state.externalRevision };
		if (response.status === 304) return { state: nextState, notModified: true };
		if (!response.ok) throw new Error("HTTP source request failed with status " + response.status);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > this.maxBytes) throw new Error("HTTP source payload exceeds size limit");
		const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const path = basename(url.pathname) || this.id;
		return { state: nextState, notModified: false, document: { externalId: this.id, suggestedPath: "files/http/" + this.id + extname(path || ".md"), content, contentHash: contentHash(content), deleted: false, externalRevision: nextState.externalRevision, updatedAt: new Date().toISOString(), provenance: { sourceType: "http", sourcePath: url.toString(), retrievedAt: new Date().toISOString() } } };
	}
}

export function verifyWebhookSignature(payload: Uint8Array | string, signature: string, secret: string): boolean {
	if (!signature.startsWith("sha256=") || !secret) return false;
	const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("hex"), "utf8");
	const supplied = Buffer.from(signature.slice(7), "utf8");
	return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export class WebhookReplayGuard {
	private readonly seen = new Map<string, number>();
	constructor(private readonly retentionMs = 24 * 60 * 60_000) {}
	accept(idempotencyKey: string, now = Date.now()): void {
		if (!idempotencyKey.trim()) throw new Error("webhook idempotency key is required");
		for (const [key, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(key);
		if (this.seen.has(idempotencyKey)) throw new Error("webhook replay detected");
		this.seen.set(idempotencyKey, now + this.retentionMs);
	}
}

export class ConfinedUploadStore {
	constructor(readonly root: string, private readonly maximumBytes = 25 * 1024 * 1024) {
		if (!Number.isInteger(maximumBytes) || maximumBytes < 1) throw new Error("invalid upload limit");
	}
	async save(bytes: Uint8Array, filename: string): Promise<{ id: string; path: string; bytes: number }> {
		if (!(bytes instanceof Uint8Array) || bytes.length > this.maximumBytes) throw new Error("upload exceeds size limit");
		if (!filename.trim() || filename.includes("\0") || basename(filename) !== filename || filename.includes("/") || filename.includes("\\")) throw new Error("invalid upload filename");
		const id = randomUUID();
		const path = join(this.root, id + (extname(filename).toLowerCase() || ".bin"));
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
		return { id, path, bytes: bytes.length };
	}
}
