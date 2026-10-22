import type { HybridProjectedSearchResult } from "./brain/pglite-indexer";
import type { Config } from "./config";
import type { SearchOptions, SearchOutcome } from "./model";
import type { OperationContext, OperationRegistry } from "./brain/operation-registry";
import { loadCanonicalSelection } from "./canonical-runtime";

export function canonicalSearchOutcome(result: { results: Array<HybridProjectedSearchResult & { verifiedText: string; metadata?: Record<string, string | number | boolean | null> }>; degraded?: boolean; diagnostics?: string[]; effectiveMode?: string }, options: SearchOptions = {}): SearchOutcome {
	const requestedMode = options.mode ?? "hybrid";
	return {
		results: result.results.map((hit) => ({
			manasId: hit.citation.documentId, path: hit.path, provider: String(hit.metadata?.provider ?? "brain"),
			chunkId: hit.citation.chunkId, text: hit.verifiedText, score: hit.score,
			citation: hit.citation,
			...(hit.metadata?.title ? { title: String(hit.metadata.title) } : {}),
		})),
		requestedMode, effectiveMode: (result.effectiveMode ?? requestedMode) as SearchOutcome["effectiveMode"],
		degraded: result.degraded ?? false, diagnostics: result.diagnostics ?? [],
	};
}
export async function searchWithRegistry(registry: OperationRegistry, query: string, options: SearchOptions = {}, context: OperationContext = { scope: "read", principal: "local", tenantId: "local" }): Promise<SearchOutcome> {
	return canonicalSearchOutcome(await registry.execute(context, "retrieval.search", { query, options }) as Parameters<typeof canonicalSearchOutcome>[0], options);
}
export async function canonicalRead(config: Config, name: string, input: Record<string, unknown>): Promise<unknown | undefined> {
	const selection = await loadCanonicalSelection(config);
	if (selection?.mode !== "canonical") return undefined;
	const { callLocalService, LocalServiceError } = await import("./local-service");
	try {
		await callLocalService(config, "service.status", {}, { repositoryRoot: selection.repositoryRoot, timeoutMs: 2_000 });
	} catch (error) {
		if (!(error instanceof LocalServiceError) || error.code !== "service_unavailable") throw error;
		const { createBrainEngine } = await import("./engine");
		const engine = await createBrainEngine({ config, repositoryRoot: selection.repositoryRoot, storePath: selection.storePath });
		try { return await engine.operations.execute({ scope: "admin", tenantId: "local", principal: "local-owner" }, name, input); }
		finally { await engine.close(); }
	}
	return callLocalService(config, name, input, { repositoryRoot: selection.repositoryRoot });
}

/** Hold the same standalone engine for a whole client batch when the service is stopped. */
export async function withCanonicalOperations<T>(config: Config, action: (execute: (name: string, input: Record<string, unknown>) => Promise<unknown>) => Promise<T>): Promise<T | undefined> {
 const selection = await loadCanonicalSelection(config);
 if (selection?.mode !== "canonical") return undefined;
 const { callLocalService, LocalServiceError } = await import("./local-service");
 try { await callLocalService(config, "service.status", {}, { repositoryRoot: selection.repositoryRoot, timeoutMs: 2_000 }); }
 catch (error) {
  if (!(error instanceof LocalServiceError) || error.code !== "service_unavailable") throw error;
  const { createBrainEngine } = await import("./engine");
  const engine = await createBrainEngine({ config, repositoryRoot: selection.repositoryRoot, storePath: selection.storePath });
  try { return await action((name, input) => engine.operations.execute({ scope: "admin", tenantId: "local", principal: "local-owner" }, name, input)); }
  finally { await engine.close(); }
 }
 return action((name, input) => callLocalService(config, name, input, { repositoryRoot: selection.repositoryRoot }));
}
