import { normalizeVector } from "./vector";

export interface EmbeddingClient {
	embed(texts: string[]): Promise<number[][]>;
}

type FetchRequest = (
	input: URL | RequestInfo,
	init?: RequestInit,
) => Promise<Response>;

export interface OllamaEmbeddingOptions {
	baseUrl: string;
	model: string;
	timeoutMs: number;
	fetch?: FetchRequest;
}

function unavailable(message: string): Error {
	return new Error(`Ollama embeddings unavailable: ${message}`);
}

export function createOllamaEmbeddingClient(
	options: OllamaEmbeddingOptions,
): EmbeddingClient {
	const request = options.fetch ?? fetch;
	return {
		async embed(texts: string[]): Promise<number[][]> {
			if (!texts.length) return [];
			let response: Response;
			try {
				response = await request(
					`${options.baseUrl.replace(/\/$/, "")}/api/embed`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ model: options.model, input: texts }),
						signal: AbortSignal.timeout(options.timeoutMs),
					},
				);
			} catch (error) {
				throw unavailable(
					error instanceof Error ? error.message : String(error),
				);
			}
			if (!response.ok) throw unavailable(`HTTP ${response.status}`);
			const body = (await response.json()) as { embeddings?: unknown };
			if (
				!Array.isArray(body.embeddings) ||
				body.embeddings.length !== texts.length
			)
				throw unavailable("response did not contain one embedding per input");
			return body.embeddings.map((embedding) => {
				if (
					!Array.isArray(embedding) ||
					!embedding.every(
						(value) => typeof value === "number" && Number.isFinite(value),
					)
				)
					throw unavailable("response contained an invalid vector");
				return Array.from(normalizeVector(embedding));
			});
		},
	};
}
