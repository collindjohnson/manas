import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "providers"].join(String.fromCharCode(47));
	const { diagnoseProvider, OpenAiCompatibleEmbeddingProvider, OpenAiCompatibleGenerationProvider, OpenAiCompatibleRerankerProvider, OpenAiCompatibleStructuredExtractionProvider, OpenAiCompatibleTranscriptionProvider, modelFingerprint } = await import(modulePath);

describe("OpenAI-compatible embedding provider", () => {
	test("validates response cardinality and pinned vector dimensions", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 })) as unknown as typeof fetch;
		try {
			const provider = new OpenAiCompatibleEmbeddingProvider({ id: "local", dimensions: 2 }, "http://127.0.0.1/embeddings");
			expect(await provider.embed(["hello"])).toEqual([[0.1, 0.2]]);
		} finally { globalThis.fetch = original; }
	});

	test("keeps streaming provider response bodies readable after headers arrive", async () => {
		const encoder = new TextEncoder();
		const fetcher = (async (_input, init) => new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				const timer = setTimeout(() => {
					controller.enqueue(encoder.encode(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] })));
					controller.close();
				}, 10);
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					controller.error(new DOMException("The operation was aborted.", "AbortError"));
				}, { once: true });
			},
		}), { headers: { "content-type": "application/json" } })) as typeof fetch;
		const provider = new OpenAiCompatibleEmbeddingProvider({ id: "streaming", dimensions: 2 }, "http://127.0.0.1/embeddings", undefined, "local", { fetcher });
		expect(await provider.embed(["hello"])).toEqual([[0.1, 0.2]]);
	});

	test("rejects remote endpoints unless hosted mode is explicit", () => {
		expect(() => new OpenAiCompatibleEmbeddingProvider({ id: "local", dimensions: 2 }, "https://example.invalid/embeddings")).toThrow("explicitly configure hosted mode");
		expect(() => new OpenAiCompatibleEmbeddingProvider({ id: "local", dimensions: 2 }, "file:///tmp/embeddings")).toThrow("endpoint protocol");
		expect(() => new OpenAiCompatibleEmbeddingProvider({ id: "local", dimensions: 2 }, "http://user:pass@127.0.0.1/embeddings")).toThrow("credentials");
		expect(() => new OpenAiCompatibleEmbeddingProvider({ id: "hosted", dimensions: 2 }, "https://example.invalid/embeddings", undefined, "hosted")).not.toThrow();
	});

	test("uses a loopback OpenAI-compatible reranker and validates one score per input", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.2 }] }), { status: 200 })) as unknown as typeof fetch;
		try {
			const provider = new OpenAiCompatibleRerankerProvider("local-reranker", "http://127.0.0.1/rerank");
			expect(await provider.rerank("query", [{ id: "a", text: "first" }, { id: "b", text: "second" }])).toEqual([{ id: "b", score: 0.8 }, { id: "a", score: 0.2 }]);
		} finally { globalThis.fetch = original; }
		expect(() => new OpenAiCompatibleRerankerProvider("local-reranker", "https://example.invalid/rerank")).toThrow("explicitly configure hosted mode");
	});

	test("uses an explicit loopback generation provider without a hosted fallback", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async (_input, init) => {
			expect(JSON.parse(String(init?.body))).toMatchObject({ model: "local-generator", temperature: 0 });
			return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
		}) as typeof fetch;
		try {
			const provider = new OpenAiCompatibleGenerationProvider("local-generator", "http://127.0.0.1/generate");
			expect(await provider.generate("return JSON")).toBe("{}");
		} finally { globalThis.fetch = original; }
		expect(() => new OpenAiCompatibleGenerationProvider("local-generator", "https://example.invalid/generate")).toThrow("explicitly configure hosted mode");
	});

	test("fingerprints non-embedding local models by complete execution semantics", () => {
		const base = { kind: "generation" as const, provider: "openai-compatible", model: "local", privacy: "local" as const };
		expect(modelFingerprint(base)).not.toBe(modelFingerprint({ ...base, revision: "next" }));
		expect(modelFingerprint(base)).not.toBe(modelFingerprint({ ...base, templateVersion: "2" }));
		expect(modelFingerprint(base)).not.toBe(modelFingerprint({ ...base, privacy: "hosted" }));
		const local = new OpenAiCompatibleGenerationProvider("local", "http://127.0.0.1/generate", undefined, "local", { revision: "1" });
		expect(local.fingerprint).toBe(modelFingerprint({ ...base, revision: "1" }));
	});

	test("supports loopback transcription and structured extraction without hosted fallback", async () => {
		const original = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async (_input, init) => {
			calls += 1;
			if (init?.body instanceof FormData) {
				expect(init.body.get("model")).toBe("local-transcriber");
				expect(init.body.get("file")).toBeInstanceOf(File);
				return new Response(JSON.stringify({ text: "spoken note" }));
			}
			expect(JSON.parse(String(init?.body))).toMatchObject({ model: "local-extractor", response_format: { type: "json_schema" } });
			return new Response(JSON.stringify({ choices: [{ message: { content: "{\"topic\":\"brain\"}" } }] }));
		}) as typeof fetch;
		try {
			const transcription = new OpenAiCompatibleTranscriptionProvider("local-transcriber", "http://127.0.0.1/transcribe");
			const extraction = new OpenAiCompatibleStructuredExtractionProvider("local-extractor", "http://127.0.0.1/extract");
			await expect(transcription.transcribe(new Uint8Array([1, 2]), "audio/wav")).resolves.toBe("spoken note");
			await expect(extraction.extract("note", { type: "object" })).resolves.toEqual({ topic: "brain" });
			expect(calls).toBe(2);
			expect(() => new OpenAiCompatibleTranscriptionProvider("remote", "https://example.invalid/transcribe")).toThrow("explicitly configure hosted mode");
			await expect(extraction.extract("note", null)).rejects.toThrow("JSON schema");
		} finally { globalThis.fetch = original; }
	});

	test("rejects partial transcription and malformed extraction responses", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [] }))) as unknown as typeof fetch;
		try {
			const transcription = new OpenAiCompatibleTranscriptionProvider("local-transcriber", "http://127.0.0.1/transcribe");
			await expect(transcription.transcribe(new Uint8Array([1]))).rejects.toThrow("invalid response");
			const extraction = new OpenAiCompatibleStructuredExtractionProvider("local-extractor", "http://127.0.0.1/extract");
			await expect(extraction.extract("note", { type: "object" })).rejects.toThrow("invalid response");
		} finally { globalThis.fetch = original; }
	});

	test("diagnoses local provider protocols without falling back to hosted endpoints", async () => {
		const diagnostic = await diagnoseProvider({ endpoint: "http://127.0.0.1:11434/api/tags", fetcher: async () => new Response("ok", { status: 200 }) });
		expect(diagnostic).toMatchObject({ protocol: "ollama", privacy: "local", reachable: true, status: 200 });
		const failed = await diagnoseProvider({ endpoint: "http://127.0.0.1:8080/health", fetcher: async () => { throw new Error("offline"); } });
		expect(failed).toMatchObject({ protocol: "llama.cpp", reachable: false, error: "offline" });
		await expect(diagnoseProvider({ endpoint: "https://example.invalid/v1/models" })).rejects.toThrow("loopback");
	});

	test("keeps every local provider offline when networking is disabled", async () => {
		const original = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			throw new Error("network disabled");
		}) as unknown as typeof fetch;
		try {
			const embedding = new OpenAiCompatibleEmbeddingProvider({ id: "local-embedding", dimensions: 2 }, "http://127.0.0.1/embeddings");
			const reranker = new OpenAiCompatibleRerankerProvider("local-reranker", "http://127.0.0.1/rerank");
			const generation = new OpenAiCompatibleGenerationProvider("local-generation", "http://127.0.0.1/generate");
			const transcription = new OpenAiCompatibleTranscriptionProvider("local-transcriber", "http://127.0.0.1/transcribe");
			const extraction = new OpenAiCompatibleStructuredExtractionProvider("local-extractor", "http://127.0.0.1/extract");
			await expect(embedding.embed(["offline"])).rejects.toThrow("network disabled");
			await expect(reranker.rerank("offline", [{ id: "one", text: "text" }])).rejects.toThrow("network disabled");
			await expect(generation.generate("offline")).rejects.toThrow("network disabled");
			await expect(transcription.transcribe(new Uint8Array([1]))).rejects.toThrow("network disabled");
			await expect(extraction.extract("offline", { type: "object" })).rejects.toThrow("network disabled");
			expect(calls).toBe(5);
		} finally { globalThis.fetch = original; }
	});

	test("enforces bounded timeouts for every local provider request", async () => {
		const hanging = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
		const embedding = new OpenAiCompatibleEmbeddingProvider({ id: "local-embedding", dimensions: 2 }, "http://127.0.0.1/embeddings", undefined, "local", { timeoutMs: 5, fetcher: hanging });
		const reranker = new OpenAiCompatibleRerankerProvider("local-reranker", "http://127.0.0.1/rerank", undefined, "local", {}, { timeoutMs: 5, fetcher: hanging });
		const generation = new OpenAiCompatibleGenerationProvider("local-generation", "http://127.0.0.1/generate", undefined, "local", {}, { timeoutMs: 5, fetcher: hanging });
		const transcription = new OpenAiCompatibleTranscriptionProvider("local-transcriber", "http://127.0.0.1/transcribe", undefined, "local", {}, { timeoutMs: 5, fetcher: hanging });
		const extraction = new OpenAiCompatibleStructuredExtractionProvider("local-extractor", "http://127.0.0.1/extract", undefined, "local", {}, { timeoutMs: 5, fetcher: hanging });
		await expect(embedding.embed(["timeout"])).rejects.toThrow("timed out");
		await expect(reranker.rerank("timeout", [{ id: "one", text: "text" }])).rejects.toThrow("timed out");
		await expect(generation.generate("timeout")).rejects.toThrow("timed out");
		await expect(transcription.transcribe(new Uint8Array([1]))).rejects.toThrow("timed out");
		await expect(extraction.extract("timeout", { type: "object" })).rejects.toThrow("timed out");
		expect(() => new OpenAiCompatibleEmbeddingProvider({ id: "local", dimensions: 2 }, "http://127.0.0.1/embeddings", undefined, "local", { timeoutMs: 0 })).toThrow("timeout");
	});
});
