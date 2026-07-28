export class ZeroEntropyError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly retryAfterMs?: number,
		readonly category:
			| "authentication"
			| "not_found"
			| "rate_limited"
			| "timeout"
			| "network"
			| "contract"
			| "http" = "http",
	) {
		super(`ZeroEntropy unavailable: ${message}`);
	}
	get retryable(): boolean {
		return (
			this.category === "network" ||
			this.category === "timeout" ||
			this.status === 408 ||
			this.status === 429 ||
			(this.status !== undefined && this.status >= 500)
		);
	}
}

export interface ZeroEntropyDocument {
	id: string;
	text: string;
	metadata: Record<string, string | string[]>;
}
export interface ZeroEntropySnippet {
	id: string;
	score: number;
	text?: string;
	metadata?: Record<string, unknown>;
	startOffset?: number;
	endOffset?: number;
}
export type ZeroEntropyMetadataFilter = Record<string, { $eq: string }>;
export interface ZeroEntropyClient {
	ensureCollection(): Promise<void>;
	upsert(documents: ZeroEntropyDocument[]): Promise<void>;
	remove(ids: string[]): Promise<void>;
	search(
		query: string,
		limit: number,
		metadata?: ZeroEntropyMetadataFilter,
	): Promise<ZeroEntropySnippet[]>;
	status?(): Promise<unknown>;
	documentStatus?(paths: string[]): Promise<Map<string, string>>;
}
type Fetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;
const sleep: Sleep = (milliseconds) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));
const MAX_RETRY_DELAY_MS = 10_000;
// These are the documented document index states used by the reconciliation
// protocol. Unknown values are intentionally a contract error, not active work.
const DOCUMENT_STATES = new Set([
	"not_parsed",
	"uploaded",
	"parsing",
	"not_indexed",
	"indexing",
	"indexed",
	"parsing_failed",
	"indexing_failed",
]);

function retryAfter(
	value: string | null,
	now: () => number,
): number | undefined {
	if (!value) return undefined;
	if (/^\d+$/.test(value)) return Number(value) * 1000;
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now());
}
function safeMessage(
	status: number,
	value: string | null,
	now: () => number,
): ZeroEntropyError {
	return new ZeroEntropyError(
		status === 401 || status === 403
			? "authentication failed"
			: status === 404
				? "collection was not found"
				: status === 429
					? "rate limited"
					: `HTTP ${status}`,
		status,
		retryAfter(value, now),
		status === 401 || status === 403
			? "authentication"
			: status === 404
				? "not_found"
				: status === 429
					? "rate_limited"
					: "http",
	);
}
function retryable(error: unknown): boolean {
	return error instanceof ZeroEntropyError
		? error.retryable
		: true;
}
function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** A small adapter over the documented ZeroEntropy HTTP/OpenAPI operations. */
export function createZeroEntropyClient(options: {
	baseUrl: string;
	collection: string;
	apiKey: string;
	timeoutMs: number;
	fetch?: Fetch;
	sleep?: Sleep;
	now?: () => number;
	retryAttempts?: number;
	retryBackoffMs?: number;
}): ZeroEntropyClient {
	const baseUrl = options.baseUrl.replace(/\/$/, "");
	const attempts = options.retryAttempts ?? 3;
	const now = options.now ?? Date.now;
	const request = async (
		path: string,
		body: unknown,
		canRetry = true,
	): Promise<unknown> => {
		let last: unknown;
		for (let attempt = 0; attempt < attempts; attempt++) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), options.timeoutMs);
			try {
				const response = await (options.fetch ?? fetch)(`${baseUrl}${path}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${options.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				if (!response.ok)
					throw safeMessage(
						response.status,
						response.headers.get("retry-after"),
						now,
					);
				const value = await response.json().catch(() => ({}));
				if (
					path.endsWith("add-document") ||
					path.endsWith("add-collection")
				) {
					const result = object(value);
					if (!result || typeof result.message !== "string")
						throw new ZeroEntropyError(
							"malformed mutation response",
							undefined,
							undefined,
							"contract",
						);
				}
				if (path.endsWith("delete-document")) {
					const result = object(value);
					const deleted = result?.deleted_paths;
					const requested = object(body)?.path;
					if (
						!Array.isArray(deleted) ||
						!deleted.every((item) => typeof item === "string") ||
						!Array.isArray(requested) ||
						!requested.every((item) => typeof item === "string") ||
						deleted.some((item) => !requested.includes(item)) ||
						requested.some((item) => !deleted.includes(item))
					)
						throw new ZeroEntropyError(
							"remote deletion did not converge",
							undefined,
							undefined,
							"contract",
						);
				}
				if (path.endsWith("get-status") && !object(value))
					throw new ZeroEntropyError(
						"malformed status response",
						undefined,
						undefined,
						"contract",
					);
				return value;
			} catch (error) {
				last =
					error instanceof ZeroEntropyError
						? error
						: new ZeroEntropyError(
								error instanceof Error && error.name === "AbortError"
									? "request timed out"
									: "network request failed",
								undefined,
								undefined,
								error instanceof Error && error.name === "AbortError"
									? "timeout"
									: "network",
						);
				if (!canRetry || !retryable(last) || attempt + 1 >= attempts)
					throw last;
				const delay = Math.min(
					MAX_RETRY_DELAY_MS,
					last instanceof ZeroEntropyError && last.retryAfterMs !== undefined
						? last.retryAfterMs
						: (options.retryBackoffMs ?? 250) * 2 ** attempt,
				);
				await (options.sleep ?? sleep)(delay);
			} finally {
				clearTimeout(timer);
			}
		}
		throw last instanceof Error
			? last
			: new ZeroEntropyError("network request failed");
	};
	return {
		async ensureCollection() {
			const listed = object(
				await request("/collections/get-collection-list", {}),
			);
			const names = listed?.collection_names;
			if (
				!Array.isArray(names) ||
				!names.every((name) => typeof name === "string")
			)
				throw new ZeroEntropyError("malformed collection response");
			if (!names.includes(options.collection)) {
				try {
					await request(
						"/collections/add-collection",
						{ collection_name: options.collection },
						false,
					);
				} catch (error) {
					if (!(error instanceof ZeroEntropyError) || error.status !== 409)
						throw error;
				}
			}
		},
		async upsert(documents) {
			for (const document of documents) {
				const body = {
					collection_name: options.collection,
					path: document.id,
					content: { type: "text", text: document.text },
					metadata: document.metadata,
				};
				try {
					await request("/documents/add-document", body);
				} catch (error) {
					// The live service currently rejects its documented overwrite option. A
					// conflict is converged by deleting this exact path before recreating it.
					if (!(error instanceof ZeroEntropyError) || error.status !== 409)
						throw error;
					await request("/documents/delete-document", {
						collection_name: options.collection,
						path: [document.id],
					});
					await request("/documents/add-document", body);
				}
			}
		},
		async remove(ids) {
			for (let index = 0; index < ids.length; index += 64) {
				const paths = ids.slice(index, index + 64);
				try {
					await request("/documents/delete-document", {
						collection_name: options.collection,
						path: paths,
					});
				} catch (error) {
					// A single missing remote document is already converged; mixed batches are not assumed safe.
					if (
						!(error instanceof ZeroEntropyError) ||
						error.status !== 404 ||
						paths.length !== 1
					)
						throw error;
				}
			}
		},
		async search(query, limit, metadata) {
			if (!Number.isInteger(limit) || limit < 1 || limit > 128)
				throw new ZeroEntropyError("search limit must be between 1 and 128");
			const body = object(
				await request("/queries/top-snippets", {
					collection_name: options.collection,
					query,
					k: limit,
					precise_responses: true,
					include_document_metadata: true,
					...(metadata ? { filter: metadata } : {}),
				}),
			);
			if (!Array.isArray(body?.results))
				throw new ZeroEntropyError("malformed search response");
			return body.results.map((item): ZeroEntropySnippet => {
				const result = object(item);
				if (
					!result ||
					typeof result.path !== "string" ||
					typeof result.score !== "number"
				)
					throw new ZeroEntropyError("malformed search result");
				return {
					id: result.path,
					score: result.score,
					text: typeof result.content === "string" ? result.content : undefined,
					metadata: object(result.metadata),
					startOffset:
						typeof result.start_offset === "number"
							? result.start_offset
							: undefined,
					endOffset:
						typeof result.end_offset === "number"
							? result.end_offset
							: undefined,
				};
			});
		},
		status: () => request("/status/get-status", {}),
		async documentStatus(paths) {
			const states = new Map<string, string>();
			let pathGt: string | undefined;
			const cursors = new Set<string>();
			for (let page = 0; page < 64; page++) {
				const body = object(
					await request("/documents/get-document-info-list", {
						collection_name: options.collection,
						limit: 1024,
						...(pathGt ? { path_gt: pathGt } : {}),
					}),
				);
				const documents = body?.documents;
				if (!Array.isArray(documents))
					throw new ZeroEntropyError("malformed document status response");
				for (const entry of documents) {
					const row = object(entry);
					// Live API documents use index_status. Read only the two fields needed
					// here: records may also contain short-lived signed file URLs.
					if (
						!row ||
						typeof row.path !== "string" ||
						typeof row.index_status !== "string" ||
						!DOCUMENT_STATES.has(row.index_status)
					)
						throw new ZeroEntropyError("malformed document status");
					if (paths.includes(row.path)) states.set(row.path, row.index_status);
				}
				if (documents.length < 1024) break;
				const last = object(documents.at(-1));
				if (!last || typeof last.path !== "string" || cursors.has(last.path))
					throw new ZeroEntropyError("document status pagination did not advance");
				cursors.add(last.path);
				pathGt = last.path;
				if (page === 63)
					throw new ZeroEntropyError("document status pagination limit exceeded");
			}
			for (const path of paths) {
				if (states.has(path)) continue;
				try {
					const body = object(
						await request(
							`${String.fromCharCode(47)}documents/get-document-info`,
							{
								collection_name: options.collection,
								path,
								include_content: false,
							},
						),
					);
					const document = object(body?.document);
					if (
						!document ||
						document.path !== path ||
						typeof document.index_status !== "string" ||
						!DOCUMENT_STATES.has(document.index_status)
					)
						throw new ZeroEntropyError("malformed single document status");
					states.set(path, document.index_status);
				} catch (error) {
					if (!(error instanceof ZeroEntropyError) || error.status !== 404)
						throw error;
				}
			}
			return states;
		},
	};
}

export type CredentialSource = "environment" | "keychain" | "missing";
export async function resolveZeroEntropyCredential(
	service: string,
	account: string,
	exec = Bun.spawn,
): Promise<{ value?: string; source: CredentialSource }> {
	if (process.env.ZEROENTROPY_API_KEY)
		return { value: process.env.ZEROENTROPY_API_KEY, source: "environment" };
	if (process.platform !== "darwin") return { source: "missing" };
	const subprocess = exec(
		["security", "find-generic-password", "-s", service, "-a", account, "-w"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if ((await subprocess.exited) === 0) {
		const value = (await new Response(subprocess.stdout).text()).trim();
		if (value) return { value, source: "keychain" };
	}
	// Support a generic-password item named after the conventional environment
	// variable without exposing its account name, value, or Keychain output.
	const fallback = exec(
		["security", "find-generic-password", "-s", "ZEROENTROPY_API_KEY", "-w"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if ((await fallback.exited) !== 0) return { source: "missing" };
	const value = (await new Response(fallback.stdout).text()).trim();
	return value ? { value, source: "keychain" } : { source: "missing" };
}
export async function resolveZeroEntropyApiKey(
	service: string,
	account: string,
	exec = Bun.spawn,
): Promise<string | undefined> {
	return (await resolveZeroEntropyCredential(service, account, exec)).value;
}
