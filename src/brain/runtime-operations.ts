import type { Config, ProviderEndpointConfig } from "../config";
import type { BrainRepository } from "./repository";
import type { BrainStore } from "./store";
import type { OperationContext } from "./operation-registry";
import type { EmbeddingProvider, TranscriptionProvider } from "./providers";
import { diagnoseBrain } from "./diagnostics";
import { detectSchemaPack } from "./schema";
import { indexLocalEmbeddings } from "./local-embeddings";
import { ensureCurrentBrainProjection, relatedBrainPages, traverseBrainGraph } from "./pglite-indexer";
import { PlainTextExtractor, PdfExtractor, OfficeDocumentExtractor, ArchiveMetadataExtractor, BinaryMetadataExtractor, AudioTranscriptionExtractor, extractLocalFile, createAuditExtractionQuarantineSink } from "../sources/extractors";

const embeddingDescriptor = { type: "object", required: ["endpoint", "model", "dimensions"], properties: { endpoint: { type: "string" }, model: { type: "string" }, dimensions: { type: "integer", minimum: 1 } }, additionalProperties: false } as const;
const rerankingDescriptor = { type: "object", required: ["endpoint", "model"], properties: { endpoint: { type: "string" }, model: { type: "string" } }, additionalProperties: false } as const;
const empty = { type: "object", properties: {}, additionalProperties: false } as const;
export const RUNTIME_OPERATION_CATALOG = [
 { name: "runtime.init", scope: "admin", boundary: "local-only", schema: empty },
 { name: "runtime.verify", scope: "admin", boundary: "local-only", schema: { type: "object", properties: { ref: { type: "string" } }, additionalProperties: false } },
 { name: "runtime.doctor", scope: "admin", boundary: "local-only", schema: empty },
 { name: "runtime.schema-candidates", scope: "admin", boundary: "local-only", schema: empty },
 { name: "runtime.source-inventory", scope: "admin", boundary: "local-only", schema: empty },
 { name: "runtime.assert-providers", scope: "admin", boundary: "local-only", schema: { type: "object", properties: { embedding: embeddingDescriptor, reranking: rerankingDescriptor }, additionalProperties: false } },
 { name: "runtime.extract", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false } },
 { name: "projection.embed", scope: "admin", boundary: "local-only", schema: empty },
 { name: "retrieval.traverse", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["path"], properties: { path: { type: "string" }, depth: { type: "integer", minimum: 1, maximum: 5 } }, additionalProperties: false } },
] as const;
export type RuntimeDependencies = { repository: BrainRepository; store?: BrainStore; config?: Config; embeddingProvider?: EmbeddingProvider; transcriptionProvider?: TranscriptionProvider };
const fail = (code: string, message: string, fix: string): never => { throw Object.assign(new Error(message), { code, retryable: false, suggestedFix: fix }); };
export async function executeRuntimeOperation(dependencies: RuntimeDependencies, context: OperationContext, name: string, input: Record<string, unknown>) {
 const { repository, store } = dependencies;
 if (name !== "retrieval.traverse" && (context.scope !== "admin" || context.allowedAccessLabels !== undefined)) fail("owner_access_required", "This runtime operation requires owner administration.", "Use the authenticated local owner service.");
 if (context.tenantId && context.tenantId !== "local") fail("unauthorized", "Brain scope is not authorized.", "Select an authorized brain.");
 if (name === "runtime.init" && !context.brainId) await repository.initialize();
 // Standalone extraction may be used without initializing a knowledge repository.
 const identity = name === "runtime.extract" && !context.brainId ? undefined : await repository.getIdentity();
 if (context.brainId && context.brainId !== identity?.brainId) fail("unauthorized", "Brain scope is not authorized.", "Select an authorized brain.");
 context.signal?.throwIfAborted();
 const requiredStore = () => store ?? fail("store_not_configured", "An operational store is required.", "Start the service or pass --store <directory> outside the Git brain.");
 if (name === "runtime.init") { await repository.ensureInitialCommit(); return { initialized: true, root: repository.root }; }
 if (name === "runtime.verify") return repository.verify(input.ref as string | undefined);
 if (name === "runtime.doctor") return diagnoseBrain(repository, store);
 if (name === "runtime.schema-candidates") return { candidates: detectSchemaPack((await repository.listPages()).map((page) => page.path)) };
 if (name === "runtime.source-inventory") {
  const sources = new Map<string, { id: string; documents: number; stale: number }>();
  for (const page of await repository.listPages(true)) if (page.source) {
   const value = sources.get(page.source.type) ?? { id: page.source.type, documents: 0, stale: 0 };
   value.documents++; if (page.stale) value.stale++; sources.set(value.id, value);
  }
  return { sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)) };
 }
 if (name === "runtime.assert-providers") {
  const config = dependencies.config ?? fail("provider_config_missing", "Runtime provider configuration is unavailable.", "Configure providers on the service.");
  const descriptor = (value?: ProviderEndpointConfig) => value && ({ endpoint: value.endpoint.replace(/\/$/, ""), model: value.model, ...(value.dimensions !== undefined ? { dimensions: value.dimensions } : {}) });
  const configured = { embedding: descriptor(config.providers?.embedding), reranking: descriptor(config.providers?.reranking ?? (config.brain?.rerankerEndpoint && config.brain.rerankerModel ? { endpoint: config.brain.rerankerEndpoint, model: config.brain.rerankerModel, privacy: "local" } : undefined)) };
  for (const kind of ["embedding", "reranking"] as const) if (input[kind] !== undefined) {
   const requested = input[kind] as Record<string, unknown>, actual = configured[kind];
   if (!actual || typeof requested.endpoint !== "string" || requested.endpoint.replace(/\/$/, "") !== actual.endpoint || requested.model !== actual.model || kind === "embedding" && requested.dimensions !== (actual as { dimensions?: number }).dimensions) fail("provider_config_mismatch", "CLI model flags differ from the running service configuration.", "Configure the service with the requested local provider and restart it, or omit the legacy flags.");
  }
  return { matched: true };
 }
 if (name === "runtime.extract") {
  const result = await extractLocalFile(String(input.path), [new AudioTranscriptionExtractor(dependencies.transcriptionProvider), new PlainTextExtractor(), new PdfExtractor(), new OfficeDocumentExtractor(), new ArchiveMetadataExtractor(), new BinaryMetadataExtractor()], undefined, store ? createAuditExtractionQuarantineSink(store) : undefined);
  context.signal?.throwIfAborted();
  return result;
 }
 const operational = requiredStore();
 await ensureCurrentBrainProjection(operational, repository);
 context.signal?.throwIfAborted();
 if (name === "projection.embed") {
  const provider = dependencies.embeddingProvider ?? fail("local_model_not_configured", "Local embeddings are not configured.", "Configure providers.embedding with a local endpoint, model and dimensions.");
  const result = await indexLocalEmbeddings(operational, provider, 32, { tenantId: "local", brainId: identity!.brainId });
  context.signal?.throwIfAborted();
  return result;
 }
 const depth = Number(input.depth ?? 1);
 return { pages: depth === 1 ? await relatedBrainPages(operational, String(input.path), identity!.brainId, "local", context.allowedAccessLabels, repository) : await traverseBrainGraph(operational, String(input.path), identity!.brainId, depth, 100, "local", context.allowedAccessLabels, repository) };
}
