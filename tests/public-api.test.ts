import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { AdminActionContext, Citation, McpRateLimit, ProjectionDelta, SourceHealth } from "../src/index";

const modulePath = ["..", "src", "index"].join(String.fromCharCode(47));
const api = await import(modulePath);
const packageApi = await import("manas");
const packageManifest = JSON.parse(await readFile([process.cwd(), "package.json"].join(String.fromCharCode(47)), "utf8")) as { version: string };

describe("public library API", () => {
	test("exports stable contract types from the package root", () => {
		const contract: { citation: Citation; delta: ProjectionDelta; rateLimit: McpRateLimit; health: SourceHealth; admin: AdminActionContext } | undefined = undefined;
		expect(contract).toBeUndefined();
	});

	test("exports the repository, projection, jobs, capture, schema, and ingestion entry points", () => {
		expect(api.BRAIN_STORE_SCHEMA_VERSION).toBe(24);
		for (const name of ["BrainRepository", "openPgliteBrainStore", "indexBrainRepository", "indexBrainRepositoryIsolated", "indexBrainRepositoryIncremental", "computeProjectionDelta", "searchBrainRepository", "searchVerifiedBrainRepository", "rerankProjectedSearchResults", "relatedBrainPages", "traverseBrainGraph", "sourceHealth", "enqueueJob", "runOneJob", "acquireSchedulerLease", "renewSchedulerLease", "releaseSchedulerLease", "DurableJobHandlerRegistry", "createParityJobHandlers", "updateJobProgress", "recordJobEvent", "attachJob", "cancelJobTree", "createJobSchedule", "createPersonalAccessToken", "identifyPersonalAccessToken", "listAuditEvents", "captureBrainNote", "inferSchemaType", "assertSchemaPack", "detectSchemaPack", "planSchemaUpgrade", "modelFingerprint", "OpenAiCompatibleGenerationProvider", "OpenAiCompatibleRerankerProvider", "OpenAiCompatibleTranscriptionProvider", "OpenAiCompatibleStructuredExtractionProvider", "diagnoseProvider", "SourcePluginRegistry", "verifySourcePlugin", "syncSource", "createPgliteIngestionRunLifecycle", "assertNormalizedDocuments", "extractLocalFile", "PdfExtractor", "ImageOcrExtractor", "diagnoseBrain", "OAuthAuthorizationServer", "DurableOAuthAuthorizationServer", "OAuthHttpService", "serializeSessionCookie", "readSessionCookie", "validateSessionRequest", "AgentRunStore", "OperationRegistry", "createFullOperationRegistry", "TenantDirectory", "SqlTenantDirectory", "DurableControlPlane", "SkillRegistry", "recordSkillFeedback", "listSkillFeedback", "buildReasonedAnswer", "routeMultiSourceQuery", "routeMultiBrainQuery", "buildScorecard", "recallMemories", "forgetMemory", "detectAnomalies", "refreshEmbeddingCoverage", "setScopedCache", "getScopedCache", "invalidateScopedCache", "recordFact", "recordClaim", "recordTimelineEvent", "persistModelActivation", "activatePersistedModel", "loadActiveModels", "runAuthorizationFuzz", "runIncidentDrill", "loadConfig", "McpSessionManager", "callMcpHttp", "autocutHybridResults", "inventoryBackup", "verifyRepositoryBackup", "DurableAdminActionService"])
			expect(typeof api[name]).toBe("function");
	});

	test("resolves the documented package root export", () => {
		expect(typeof packageApi.BrainRepository).toBe("function");
	});

	test("publishes a semver package root with the complete compatibility surface", () => {
		expect(packageManifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(typeof packageApi.createBrainEngine).toBe("function");
		expect(typeof packageApi.callMcpHttp).toBe("function");
		expect(typeof packageApi.OpenAiCompatibleEmbeddingProvider).toBe("function");
		expect(typeof packageApi.verifySourceAdapterConformance).toBe("function");
	});
});
