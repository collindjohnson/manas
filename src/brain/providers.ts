import { createHash } from "node:crypto";

export interface EmbeddingModel {
	id: string;
	dimensions: number;
	fingerprint?: string;
}

export interface EmbeddingProvider {
	model: EmbeddingModel;
	embed(texts: string[]): Promise<number[][]>;
}

export interface RerankerProvider {
	id: string;
	rerank(query: string, documents: Array<{ id: string; text: string }>): Promise<Array<{ id: string; score: number }>>;
}

export interface GenerationProvider {
	id: string;
	generate(prompt: string): Promise<string>;
}

export interface TranscriptionProvider {
	id: string;
	transcribe(audio: Uint8Array, mimeType?: string): Promise<string>;
}

export interface StructuredExtractionProvider {
	id: string;
	extract(input: string, schema: unknown): Promise<unknown>;
}

export type ModelKind = "embedding" | "reranking" | "generation" | "transcription" | "extraction";
export interface ModelDescriptor {
	kind: ModelKind;
	provider: string;
	model: string;
	revision?: string;
	dimensions?: number;
	normalized?: boolean;
	templateVersion?: string;
	privacy: "local" | "hosted";
}

export type LocalProviderProtocol = "ollama" | "llama.cpp" | "openai-compatible";
export interface ProviderDiagnostic {
	endpoint: string;
	protocol: LocalProviderProtocol;
	privacy: "local" | "hosted";
	reachable: boolean;
	status?: number;
	latencyMs?: number;
	error?: string;
}

export interface ProviderRequestOptions {
	timeoutMs?: number;
	fetcher?: typeof fetch;
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

function requestOptions(options: ProviderRequestOptions | undefined): Required<ProviderRequestOptions> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("invalid provider request timeout");
	return { timeoutMs, fetcher: options?.fetcher ?? fetch };
}

async function providerRequest(
	fetcher: typeof fetch,
	input: RequestInfo | URL,
	init: RequestInit,
	timeoutMs: number,
	kind: string,
): Promise<Response> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error(`${kind} provider request timed out`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			fetcher(input, { ...init, signal: controller.signal }),
			timeout,
		]);
	} finally {
		if (timer) clearTimeout(timer);
		controller.abort();
	}
}

export function modelFingerprint(descriptor: ModelDescriptor): string {
	if (!descriptor.provider.trim() || !descriptor.model.trim()) throw new Error("invalid model descriptor");
	if (descriptor.dimensions !== undefined && (!Number.isInteger(descriptor.dimensions) || descriptor.dimensions < 1)) throw new Error("invalid model dimensions");
	return createHash("sha256").update(JSON.stringify({ kind: descriptor.kind, provider: descriptor.provider, model: descriptor.model, revision: descriptor.revision ?? "", dimensions: descriptor.dimensions ?? null, normalized: descriptor.normalized ?? true, templateVersion: descriptor.templateVersion ?? "1", privacy: descriptor.privacy })).digest("hex");
}

function assertModelEndpoint(endpoint: string, privacy: "local" | "hosted", kind: string): void {
	let url: URL;
	try { url = new URL(endpoint); } catch { throw new Error(`invalid ${kind} endpoint`); }
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`invalid ${kind} endpoint protocol`);
	if (url.username || url.password) throw new Error(`${kind} endpoint must not contain credentials`);
	const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
	if (privacy === "local" && !localHost) throw new Error(`local ${kind} mode requires a loopback endpoint; explicitly configure hosted mode to send text remotely`);
}

function providerProtocol(url: URL): LocalProviderProtocol {
	if (url.pathname.startsWith("/api/")) return "ollama";
	if (url.pathname === "/health" || url.pathname.startsWith("/completion")) return "llama.cpp";
	return "openai-compatible";
}

export async function diagnoseProvider(options: { endpoint: string; privacy?: "local" | "hosted"; timeoutMs?: number; fetcher?: typeof fetch }): Promise<ProviderDiagnostic> {
	let url: URL;
	try { url = new URL(options.endpoint); } catch { throw new Error("invalid provider endpoint"); }
	const privacy = options.privacy ?? "local";
	assertModelEndpoint(options.endpoint, privacy, "provider");
	const timeoutMs = options.timeoutMs ?? 3_000;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("invalid provider diagnostic timeout");
	const protocol = providerProtocol(url);
	const fetcher = options.fetcher ?? fetch;
	const started = Date.now();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetcher(url, { method: "GET", signal: controller.signal });
		return { endpoint: options.endpoint, protocol, privacy, reachable: response.ok, status: response.status, latencyMs: Date.now() - started, ...(response.ok ? {} : { error: `provider returned HTTP ${response.status}` }) };
	} catch (error) {
		return { endpoint: options.endpoint, protocol, privacy, reachable: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 200) : "provider request failed" };
	} finally {
		clearTimeout(timeout);
	}
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
	private readonly request: Required<ProviderRequestOptions>;
	constructor(readonly model: EmbeddingModel, private readonly endpoint: string, private readonly apiKey?: string, privacy: "local" | "hosted" = "local", options?: ProviderRequestOptions) {
		assertModelEndpoint(endpoint, privacy, "embedding");
		this.request = requestOptions(options);
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (!texts.length) return [];
		const response = await providerRequest(this.request.fetcher, this.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
			body: JSON.stringify({ model: this.model.id, input: texts }),
		}, this.request.timeoutMs, "embedding");
		if (!response.ok) throw new Error("embedding provider request failed");
		const payload = await response.json() as { data?: Array<{ embedding?: unknown }> };
		if (!Array.isArray(payload.data) || payload.data.length !== texts.length) throw new Error("embedding provider returned an invalid response");
		return payload.data.map((item) => {
			if (!Array.isArray(item.embedding) || item.embedding.length !== this.model.dimensions || item.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("embedding provider returned an invalid vector");
			return item.embedding as number[];
		});
	}
}

export class OpenAiCompatibleRerankerProvider implements RerankerProvider {
	readonly fingerprint: string;
	private readonly request: Required<ProviderRequestOptions>;
	constructor(readonly id: string, private readonly endpoint: string, private readonly apiKey?: string, privacy: "local" | "hosted" = "local", descriptor: Omit<Partial<ModelDescriptor>, "kind" | "model" | "privacy"> = {}, options?: ProviderRequestOptions) {
		if (!id.trim()) throw new Error("invalid reranker model");
		assertModelEndpoint(endpoint, privacy, "reranker");
		this.request = requestOptions(options);
		this.fingerprint = modelFingerprint({ kind: "reranking", provider: descriptor.provider ?? "openai-compatible", model: id, revision: descriptor.revision, dimensions: descriptor.dimensions, normalized: descriptor.normalized, templateVersion: descriptor.templateVersion, privacy });
	}

	async rerank(query: string, documents: Array<{ id: string; text: string }>): Promise<Array<{ id: string; score: number }>> {
		if (!query.trim() || !documents.length || documents.length > 128 || documents.some((document) => !document.id || !document.text)) throw new Error("invalid reranker input");
		const response = await providerRequest(this.request.fetcher, this.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
			body: JSON.stringify({ model: this.id, query, documents: documents.map((document) => document.text) }),
		}, this.request.timeoutMs, "reranker");
		if (!response.ok) throw new Error("reranker provider request failed");
		const payload = await response.json() as { results?: Array<{ index?: unknown; relevance_score?: unknown }>; data?: Array<{ index?: unknown; score?: unknown }> };
		const values = payload.results?.map((item) => ({ index: item.index, score: item.relevance_score })) ?? payload.data?.map((item) => ({ index: item.index, score: item.score }));
		if (!values || values.length !== documents.length) throw new Error("reranker provider returned an invalid response");
		const seen = new Set<number>();
		return values.map((item) => {
			if (typeof item.index !== "number" || !Number.isInteger(item.index) || item.index < 0 || item.index >= documents.length || seen.has(item.index) || typeof item.score !== "number" || !Number.isFinite(item.score)) throw new Error("reranker provider returned an invalid response");
			seen.add(item.index);
			return { id: documents[item.index]!.id, score: item.score };
		});
	}
}

export class OpenAiCompatibleGenerationProvider implements GenerationProvider {
	readonly fingerprint: string;
	private readonly request: Required<ProviderRequestOptions>;
	constructor(readonly id: string, private readonly endpoint: string, private readonly apiKey?: string, privacy: "local" | "hosted" = "local", descriptor: Omit<Partial<ModelDescriptor>, "kind" | "model" | "privacy"> = {}, options?: ProviderRequestOptions) {
		if (!id.trim()) throw new Error("invalid generation model");
		assertModelEndpoint(endpoint, privacy, "generation");
		this.request = requestOptions(options);
		this.fingerprint = modelFingerprint({ kind: "generation", provider: descriptor.provider ?? "openai-compatible", model: id, revision: descriptor.revision, dimensions: descriptor.dimensions, normalized: descriptor.normalized, templateVersion: descriptor.templateVersion, privacy });
	}

	async generate(prompt: string): Promise<string> {
		if (!prompt.trim() || prompt.length > 100_000) throw new Error("invalid generation prompt");
		const response = await providerRequest(this.request.fetcher, this.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
			body: JSON.stringify({ model: this.id, messages: [{ role: "user", content: prompt }], temperature: 0 }),
		}, this.request.timeoutMs, "generation");
		if (!response.ok) throw new Error("generation provider request failed");
		const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
		const content = payload.choices?.[0]?.message?.content;
		if (typeof content !== "string") throw new Error("generation provider returned an invalid response");
		return content;
	}
}

function assertExtractionSchema(schema: unknown): asserts schema is Record<string, unknown> {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("structured extraction requires a JSON schema");
}

export class OpenAiCompatibleTranscriptionProvider implements TranscriptionProvider {
	readonly fingerprint: string;
	private readonly request: Required<ProviderRequestOptions>;
	constructor(readonly id: string, private readonly endpoint: string, private readonly apiKey?: string, privacy: "local" | "hosted" = "local", descriptor: Omit<Partial<ModelDescriptor>, "kind" | "model" | "privacy"> = {}, options?: ProviderRequestOptions) {
		if (!id.trim()) throw new Error("invalid transcription model");
		assertModelEndpoint(endpoint, privacy, "transcription");
		this.request = requestOptions(options);
		this.fingerprint = modelFingerprint({ kind: "transcription", provider: descriptor.provider ?? "openai-compatible", model: id, revision: descriptor.revision, dimensions: descriptor.dimensions, normalized: descriptor.normalized, templateVersion: descriptor.templateVersion, privacy });
	}

	async transcribe(audio: Uint8Array, mimeType = "application/octet-stream"): Promise<string> {
		if (!(audio instanceof Uint8Array) || audio.length === 0 || audio.length > 25 * 1024 * 1024) throw new Error("invalid transcription input");
		if (!mimeType.trim() || mimeType.includes("\n") || mimeType.includes("\r")) throw new Error("invalid transcription MIME type");
		const form = new FormData();
		form.set("model", this.id);
		const audioBytes = new Uint8Array(audio.byteLength);
		audioBytes.set(audio);
		form.set("file", new Blob([audioBytes.buffer], { type: mimeType }), "audio");
		const response = await providerRequest(this.request.fetcher, this.endpoint, { method: "POST", headers: this.apiKey ? { authorization: "Bearer ".concat(this.apiKey) } : undefined, body: form }, this.request.timeoutMs, "transcription");
		if (!response.ok) throw new Error("transcription provider request failed");
		const payload = await response.json() as { text?: unknown; output?: unknown };
		const text = typeof payload.text === "string" ? payload.text : payload.output;
		if (typeof text !== "string" || !text.trim()) throw new Error("transcription provider returned an invalid response");
		return text;
	}
}

export class OpenAiCompatibleStructuredExtractionProvider implements StructuredExtractionProvider {
	readonly fingerprint: string;
	private readonly request: Required<ProviderRequestOptions>;
	constructor(readonly id: string, private readonly endpoint: string, private readonly apiKey?: string, privacy: "local" | "hosted" = "local", descriptor: Omit<Partial<ModelDescriptor>, "kind" | "model" | "privacy"> = {}, options?: ProviderRequestOptions) {
		if (!id.trim()) throw new Error("invalid extraction model");
		assertModelEndpoint(endpoint, privacy, "extraction");
		this.request = requestOptions(options);
		this.fingerprint = modelFingerprint({ kind: "extraction", provider: descriptor.provider ?? "openai-compatible", model: id, revision: descriptor.revision, dimensions: descriptor.dimensions, normalized: descriptor.normalized, templateVersion: descriptor.templateVersion, privacy });
	}

	async extract(input: string, schema: unknown): Promise<unknown> {
		if (!input.trim() || input.length > 100_000) throw new Error("invalid structured extraction input");
		assertExtractionSchema(schema);
		const response = await providerRequest(this.request.fetcher, this.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: "Bearer ".concat(this.apiKey) } : {}) },
			body: JSON.stringify({ model: this.id, messages: [{ role: "user", content: input }], response_format: { type: "json_schema", json_schema: { name: "extraction", schema } }, temperature: 0 }),
		}, this.request.timeoutMs, "structured extraction");
		if (!response.ok) throw new Error("structured extraction provider request failed");
		const payload = await response.json() as { output?: unknown; result?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
		let value: unknown = payload.output ?? payload.result ?? payload.choices?.[0]?.message?.content;
		if (typeof value === "string") {
			try { value = JSON.parse(value); } catch { throw new Error("structured extraction provider returned malformed JSON"); }
		}
		if (value === undefined || value === null || typeof value !== "object") throw new Error("structured extraction provider returned an invalid response");
		return value;
	}
}
