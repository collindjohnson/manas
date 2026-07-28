import type { BrainStore } from "./store";
import type { DurableControlPlane } from "./control-plane";
import { createPinnedSkillRegistry } from "../skills";
import { listSkillFeedback, recordSkillFeedback } from "./skill-feedback";
import { diagnoseProvider } from "./providers";
import { createJobSchedule, enqueueJob, listJobSchedules, listJobs, cancelJob } from "./jobs";
import { createPersonalAccessToken, listPersonalAccessTokens, revokePersonalAccessToken } from "./access-tokens";
import { DurableAdminActionService } from "./admin";
import { searchVerifiedHybridBrainRepository } from "./pglite-indexer";
import { buildReasonedAnswer } from "./reasoning";
import { analyzeCodeDocument, brainstormIdeas, buildScorecard, buildTrajectory, calibrateConfidence, captureContributorQuery, detectAnomalies, diagnoseRetrieval, forgetMemory, linkDocumentation, recallMemories, replayEvaluation, routeMultiBrainQuery, routeMultiSourceQuery } from "./advanced";
import { discoverAdvancedFeatures, proposeSelfMaintenance, runAdvancedEvaluation } from "./advanced-evaluation";
import { createBrainRepositoryOperationRegistry, OperationRegistry, type JsonSchema, type OperationContext } from "./operation-registry";
import { brainRepositoryOperationNames } from "./operations";

export interface CatalogDependencies {
	repository: Parameters<typeof createBrainRepositoryOperationRegistry>[0];
	store?: BrainStore;
	controlPlane?: DurableControlPlane;
	embeddingProvider?: { model: { id: string; dimensions: number; fingerprint?: string }; embed(texts: string[]): Promise<number[][]> };
	rerankerProvider?: { rerank(query: string, documents: Array<{ id: string; text: string }>): Promise<Array<{ id: string; score: number }>> };
	handlers?: Partial<Record<CatalogOperationName, (context: OperationContext, input: Record<string, unknown>) => Promise<unknown>>>;
}

export const CONTROL_OPERATION_CATALOG = [
	{ name: "retrieval.search", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false } },
	{ name: "reasoning.answer", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["question"], properties: { question: { type: "string" } }, additionalProperties: false } },
	{ name: "models.diagnose", scope: "read", boundary: "local-only", schema: { type: "object", required: ["endpoint"], properties: { endpoint: { type: "string" }, privacy: { type: "string", enum: ["local", "hosted"] } }, additionalProperties: false } },
	{ name: "models.activate", scope: "write", boundary: "local-only", schema: { type: "object", required: ["kind", "fingerprint"], properties: { kind: { type: "string" }, fingerprint: { type: "string" }, descriptor: { type: "object" } }, additionalProperties: false } },
	{ name: "jobs.list", scope: "read", boundary: "remote-safe", schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false } },
	{ name: "jobs.enqueue", scope: "write", boundary: "local-only", schema: { type: "object", required: ["type", "payload"], properties: { type: { type: "string" }, payload: { type: "object" }, dependencyIds: { type: "array", items: { type: "string" } }, dependencyFailurePolicy: { type: "string", enum: ["cancel", "dead-letter", "degraded"] }, idempotencyKey: { type: "string" } }, additionalProperties: false } },
	{ name: "jobs.cancel", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
	{ name: "jobs.schedule", scope: "write", boundary: "local-only", schema: { type: "object", required: ["type", "payload", "intervalSeconds"], properties: { type: { type: "string" }, payload: { type: "object" }, intervalSeconds: { type: "integer", minimum: 1 }, nextRunAt: { type: "string" } }, additionalProperties: false } },
	{ name: "jobs.schedules", scope: "read", boundary: "remote-safe", schema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "sources.list", scope: "read", boundary: "remote-safe", schema: { type: "object", properties: { brainId: { type: "string" } }, additionalProperties: false } },
	{ name: "sources.enable", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["id", "enabled", "confirmation", "idempotencyKey"], properties: { id: { type: "string" }, enabled: { type: "boolean" }, confirmation: { type: "string" }, idempotencyKey: { type: "string" } }, additionalProperties: false } },
	{ name: "admin.dashboard", scope: "admin", boundary: "remote-safe", schema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "admin.audit", scope: "admin", boundary: "remote-safe", schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false } },
	{ name: "admin.audit.page", scope: "admin", boundary: "remote-safe", schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 1000 }, after: { type: "string" } }, additionalProperties: false } },
	{ name: "admin.user.create", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
	{ name: "admin.tenant.create", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["id", "name", "ownerUserId"], properties: { id: { type: "string" }, name: { type: "string" }, ownerUserId: { type: "string" } }, additionalProperties: false } },
	{ name: "admin.brain.create", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" }, canonicalRemote: { type: "string" } }, additionalProperties: false } },
	{ name: "admin.membership.grant", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["userId", "role"], properties: { userId: { type: "string" }, brainId: { type: "string" }, role: { type: "string", enum: ["member", "admin", "owner"] }, visibilityLabels: { type: "array", items: { type: "string" } } }, additionalProperties: false } },
	{ name: "admin.group.create", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } }, additionalProperties: false } },
	{ name: "admin.group.member-add", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["groupId", "userId"], properties: { groupId: { type: "string" }, userId: { type: "string" } }, additionalProperties: false } },
	{ name: "admin.visibility.grant", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["brainId", "subjectType", "subjectId", "label"], properties: { brainId: { type: "string" }, subjectType: { type: "string", enum: ["user", "group", "tenant"] }, subjectId: { type: "string" }, label: { type: "string" } }, additionalProperties: false } },
	{ name: "admin.source.register", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["id", "brainId", "version", "kind"], properties: { id: { type: "string" }, brainId: { type: "string" }, version: { type: "string" }, kind: { type: "string" }, compatibility: { type: "object" } }, additionalProperties: false } },
	{ name: "admin.oauth-client.create", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["id", "name", "redirectUris", "scopes"], properties: { id: { type: "string" }, name: { type: "string" }, redirectUris: { type: "array", items: { type: "string" } }, scopes: { type: "array", items: { type: "string" } }, publicClient: { type: "boolean" }, clientSecret: { type: "string" } }, additionalProperties: false } },
	{ name: "admin.oauth-client.revoke", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["id", "confirmation", "idempotencyKey"], properties: { id: { type: "string" }, confirmation: { type: "string" }, idempotencyKey: { type: "string" } }, additionalProperties: false } },
	{ name: "admin.token.create", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["name", "scopes"], properties: { name: { type: "string" }, scopes: { type: "array", items: { type: "string", enum: ["read", "write", "admin"] } }, userId: { type: "string" }, expiresAt: { type: "string" } }, additionalProperties: false } },
	{ name: "admin.token.list", scope: "admin", boundary: "remote-safe", schema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "admin.token.revoke", scope: "admin", boundary: "remote-safe", schema: { type: "object", required: ["id", "confirmation", "idempotencyKey"], properties: { id: { type: "string" }, confirmation: { type: "string" }, idempotencyKey: { type: "string" } }, additionalProperties: false } },
	{ name: "auth.session.create", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["userId"], properties: { userId: { type: "string" } }, additionalProperties: false } },
	{ name: "auth.session.revoke", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } }, additionalProperties: false } },
	{ name: "quota.consume", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["operation", "units", "limit", "windowMs"], properties: { operation: { type: "string" }, units: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 0 }, windowMs: { type: "integer", minimum: 1 } }, additionalProperties: false } },
	{ name: "agent.start", scope: "write", boundary: "local-only", schema: { type: "object", required: ["brainId", "agent", "operation", "baseCommit", "policy", "plannedPaths"], properties: { brainId: { type: "string" }, agent: { type: "string" }, operation: { type: "string" }, baseCommit: { type: "string" }, policy: { type: "object" }, plannedPaths: { type: "array", items: { type: "string" } } }, additionalProperties: false } },
	{ name: "agent.status", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
	{ name: "agent.update", scope: "write", boundary: "local-only", schema: { type: "object", required: ["id", "status"], properties: { id: { type: "string" }, status: { type: "string" }, proposal: { type: "object" }, result: { type: "object" }, error: { type: "string" } }, additionalProperties: false } },
	{ name: "skills.list", scope: "read", boundary: "remote-safe", schema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "skills.resolve", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["id", "agent"], properties: { id: { type: "string" }, agent: { type: "string" }, version: { type: "string" } }, additionalProperties: false } },
	{ name: "skills.push-context", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["agent", "query", "citations", "confidence"], properties: { agent: { type: "string" }, query: { type: "string" }, citations: { type: "array", items: { type: "string" } }, confidence: { type: "number", minimum: 0, maximum: 1 }, minimumConfidence: { type: "number", minimum: 0, maximum: 1 } }, additionalProperties: false } },
	{ name: "skills.feedback", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["skillId", "agent", "outcome"], properties: { id: { type: "string" }, skillId: { type: "string" }, version: { type: "string" }, agent: { type: "string" }, outcome: { type: "string", enum: ["used", "volunteered", "rejected"] }, confidence: { type: "number", minimum: 0, maximum: 1 } }, additionalProperties: false } },
	{ name: "skills.feedback.list", scope: "read", boundary: "remote-safe", schema: { type: "object", properties: { skillId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false } },
	{ name: "skills.propose", scope: "write", boundary: "local-only", schema: { type: "object", required: ["id", "agent", "changes"], properties: { id: { type: "string" }, agent: { type: "string" }, version: { type: "string" }, changes: { type: "string" } }, additionalProperties: false } },
	{ name: "skills.optimizer-propose", scope: "write", boundary: "local-only", schema: { type: "object", required: ["skillId", "version", "evidence", "expectedImprovement"], properties: { skillId: { type: "string" }, version: { type: "string" }, evidence: { type: "string" }, expectedImprovement: { type: "string" } }, additionalProperties: false } },
	{ name: "schema.upgrade.plan", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["brainId", "fromVersion", "toVersion", "changes"], properties: { brainId: { type: "string" }, fromVersion: { type: "string" }, toVersion: { type: "string" }, changes: { type: "array" } }, additionalProperties: false } },
	{ name: "schema.upgrade.approve", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
	{ name: "schema.upgrade.apply", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
	{ name: "rollback.record", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["brainId", "targetKind", "targetId", "rollbackRef"], properties: { brainId: { type: "string" }, runId: { type: "string" }, targetKind: { type: "string" }, targetId: { type: "string" }, rollbackRef: { type: "string" }, metadata: { type: "object" } }, additionalProperties: false } },
	{ name: "migration.drill", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["stage"], properties: { stage: { type: "string" } }, additionalProperties: false } },
	{ name: "security.check", scope: "admin", boundary: "local-only", schema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "integrity.check", scope: "admin", boundary: "local-only", schema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "cache.inspect", scope: "read", boundary: "remote-safe", schema: { type: "object", properties: { brainId: { type: "string" } }, additionalProperties: false } },
	{ name: "analysis.features", scope: "read", boundary: "remote-safe", schema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "analysis.evaluate", scope: "read", boundary: "remote-safe", schema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "analysis.code", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } }, additionalProperties: false } },
	{ name: "analysis.docs", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["path", "markdown", "code"], properties: { path: { type: "string" }, markdown: { type: "string" }, code: { type: "object" } }, additionalProperties: false } },
	{ name: "analysis.brainstorm", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["query"], properties: { query: { type: "string" }, context: { type: "array", items: { type: "string" } }, maximum: { type: "integer", minimum: 1, maximum: 32 } }, additionalProperties: false } },
	{ name: "analysis.scorecard", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["id", "metrics"], properties: { id: { type: "string" }, metrics: { type: "array", items: { type: "object" } } }, additionalProperties: false } },
	{ name: "analysis.calibrate", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["values"], properties: { values: { type: "array", items: { type: "object" } }, bins: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false } },
	{ name: "analysis.recall", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["records", "tenantId", "brainId", "query"], properties: { records: { type: "array", items: { type: "object" } }, tenantId: { type: "string" }, brainId: { type: "string" }, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false } },
	{ name: "analysis.forget", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["records", "tenantId", "brainId", "id"], properties: { records: { type: "array", items: { type: "object" } }, tenantId: { type: "string" }, brainId: { type: "string" }, id: { type: "string" } }, additionalProperties: false } },
	{ name: "analysis.contributor", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["id", "tenantId", "brainId", "query", "consent"], properties: { id: { type: "string" }, tenantId: { type: "string" }, brainId: { type: "string" }, query: { type: "string" }, consent: { type: "boolean" } }, additionalProperties: false } },
	{ name: "analysis.replay", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["cases"], properties: { cases: { type: "array", items: { type: "object" } } }, additionalProperties: false } },
	{ name: "analysis.trajectory", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["id", "events"], properties: { id: { type: "string" }, events: { type: "array", items: { type: "object" } }, maximumEvents: { type: "integer", minimum: 1, maximum: 10000 } }, additionalProperties: false } },
	{ name: "analysis.route.sources", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["tenantId", "query", "sources"], properties: { tenantId: { type: "string" }, query: { type: "string" }, sources: { type: "array", items: { type: "object" } }, maximumSources: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false } },
	{ name: "analysis.route.brains", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["tenantId", "query", "brains"], properties: { tenantId: { type: "string" }, query: { type: "string" }, brains: { type: "array", items: { type: "object" } }, maximumBrains: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false } },
	{ name: "analysis.diagnose", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["query", "tenantId", "brainId", "candidates"], properties: { query: { type: "string" }, tenantId: { type: "string" }, brainId: { type: "string" }, candidates: { type: "array", items: { type: "object" } } }, additionalProperties: false } },
	{ name: "analysis.anomaly", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["records"], properties: { records: { type: "array", items: { type: "object" } } }, additionalProperties: false } },
	{ name: "maintenance.propose", scope: "write", boundary: "local-only", schema: { type: "object", required: ["tenantId", "brainId", "findings"], properties: { tenantId: { type: "string" }, brainId: { type: "string" }, findings: { type: "array", items: { type: "string" } }, dryRun: { type: "boolean" } }, additionalProperties: false } },
] as const satisfies ReadonlyArray<{ name: string; scope: "read" | "write" | "admin"; boundary: "remote-safe" | "local-only" | "confined-upload"; schema: JsonSchema }>;

export type CatalogOperationName = (typeof CONTROL_OPERATION_CATALOG)[number]["name"];
export const ALL_OPERATION_NAMES = [...brainRepositoryOperationNames, ...CONTROL_OPERATION_CATALOG.map((entry) => entry.name)] as const;

function dependency<T>(value: T | undefined, name: string): T { if (!value) throw new Error(`${name} operation dependency is unavailable`); return value; }
function scopedTenant(context: OperationContext, args: Record<string, unknown>): string {
	const tenantId = typeof args.tenantId === "string" ? args.tenantId : context.tenantId ?? "local";
	if (tenantId !== (context.tenantId ?? "local")) throw new Error("operation tenant scope is insufficient");
	return tenantId;
}
function scopedBrain(context: OperationContext, args: Record<string, unknown>): string {
	const brainId = typeof args.brainId === "string" ? args.brainId : context.brainId;
	if (context.brainId && brainId !== context.brainId) throw new Error("operation brain scope is insufficient");
	if (!brainId) throw new Error("operation brain scope is required");
	return brainId;
}

export function assertOperationCatalog(): void {
	const names = CONTROL_OPERATION_CATALOG.map((entry) => entry.name);
	if (new Set(names).size !== names.length || names.some((name) => !name.includes("."))) throw new Error("operation catalog is not unique");
	for (const entry of CONTROL_OPERATION_CATALOG) if (!entry.schema.type || !entry.scope || !entry.boundary) throw new Error("operation catalog entry is incomplete");
}

export function createFullOperationRegistry(dependencies: CatalogDependencies): OperationRegistry {
	assertOperationCatalog();
	const registry = createBrainRepositoryOperationRegistry(dependencies.repository);
	for (const entry of CONTROL_OPERATION_CATALOG) {
		registry.register({ name: entry.name, description: `Execute the ${entry.name} contract.`, inputSchema: entry.schema, outputSchema: { type: "object" }, requiredScope: entry.scope, trustBoundary: entry.boundary, execute: async (context, input) => {
			const custom = dependencies.handlers?.[entry.name];
			if (custom) return custom(context, input as Record<string, unknown>);
			const args = input as Record<string, unknown>;
			const controlContext = { principal: context.principal ?? "anonymous", tenantId: context.tenantId ?? "local", ...(context.brainId ? { brainId: context.brainId } : {}), scope: context.scope };
			if (entry.name === "jobs.list") return listJobs(dependency(dependencies.store, "jobs"), Number(args.limit ?? 100), context.tenantId);
			if (entry.name === "jobs.enqueue") return enqueueJob(dependency(dependencies.store, "jobs"), { type: String(args.type), payload: args.payload, tenantId: context.tenantId, dependencyIds: Array.isArray(args.dependencyIds) ? args.dependencyIds as string[] : [], dependencyFailurePolicy: args.dependencyFailurePolicy as "cancel" | "dead-letter" | "degraded" | undefined, idempotencyKey: args.idempotencyKey as string | undefined });
			if (entry.name === "jobs.cancel") return cancelJob(dependency(dependencies.store, "jobs"), String(args.id), context.tenantId);
			if (entry.name === "jobs.schedule") {
				const nextRunAt = typeof args.nextRunAt === "string" ? new Date(args.nextRunAt) : undefined;
				if (nextRunAt && Number.isNaN(nextRunAt.getTime())) throw new Error("invalid job schedule timestamp");
				return createJobSchedule(dependency(dependencies.store, "jobs"), { type: String(args.type), payload: args.payload, intervalSeconds: Number(args.intervalSeconds), tenantId: context.tenantId, ...(nextRunAt ? { nextRunAt } : {}) });
			}
			if (entry.name === "jobs.schedules") return listJobSchedules(dependency(dependencies.store, "jobs"), context.tenantId);
			if (entry.name === "retrieval.search") {
				const repository = dependencies.repository as unknown as Parameters<typeof searchVerifiedHybridBrainRepository>[1];
				const snapshot = await repository.snapshot();
				const results = await searchVerifiedHybridBrainRepository(dependency(dependencies.store, "retrieval"), repository, String(args.query), { limit: Number(args.limit ?? 20), brainId: context.brainId ?? snapshot.brainId, tenantId: context.tenantId ?? "local", allowedAccessLabels: context.allowedAccessLabels, embeddingProvider: dependencies.embeddingProvider, rerankerProvider: dependencies.rerankerProvider });
				return { query: String(args.query), results };
			}
			if (entry.name === "reasoning.answer") {
				const repository = dependencies.repository as unknown as Parameters<typeof searchVerifiedHybridBrainRepository>[1];
				const snapshot = await repository.snapshot();
				const results = await searchVerifiedHybridBrainRepository(dependency(dependencies.store, "reasoning"), repository, String(args.question), { limit: 20, brainId: context.brainId ?? snapshot.brainId, tenantId: context.tenantId ?? "local", allowedAccessLabels: context.allowedAccessLabels, embeddingProvider: dependencies.embeddingProvider, rerankerProvider: dependencies.rerankerProvider });
				const evidence = results.map((result) => ({ text: result.verifiedText, citation: { ...result.citation, projectedCommit: result.citation.commit } }));
				return { question: String(args.question), ...buildReasonedAnswer({ answer: results.map((result) => result.verifiedText).join("\n\n"), evidence }) };
			}
			if (entry.name === "models.diagnose") return diagnoseProvider({ endpoint: String(args.endpoint), privacy: args.privacy === "hosted" ? "hosted" : "local" });
			if (entry.name === "models.activate") {
				const store = dependency(dependencies.store, "models");
				const descriptor = { ...(args.descriptor && typeof args.descriptor === "object" && !Array.isArray(args.descriptor) ? args.descriptor : {}), kind: String(args.kind), fingerprint: String(args.fingerprint) };
				await store.query("UPDATE brain_model_descriptors SET active = false WHERE tenant_id = $1 AND brain_id = $2 AND kind = $3", [context.tenantId ?? "local", context.brainId ?? "local", String(args.kind)]);
				await store.query("INSERT INTO brain_model_descriptors (id, tenant_id, brain_id, kind, fingerprint, descriptor, active) VALUES ($1, $2, $3, $4, $5, $6::jsonb, true) ON CONFLICT (tenant_id, brain_id, kind, fingerprint) DO UPDATE SET descriptor = EXCLUDED.descriptor, active = true", [String(args.fingerprint).slice(0, 64), context.tenantId ?? "local", context.brainId ?? "local", String(args.kind), String(args.fingerprint), JSON.stringify(descriptor)]);
				return { kind: String(args.kind), fingerprint: String(args.fingerprint), active: true };
			}
			if (entry.name === "analysis.features") return discoverAdvancedFeatures();
			if (entry.name === "analysis.evaluate") return runAdvancedEvaluation();
			if (entry.name === "analysis.code") return analyzeCodeDocument(String(args.path), String(args.content));
			if (entry.name === "analysis.docs") return linkDocumentation(String(args.path), String(args.markdown), args.code as never);
			if (entry.name === "analysis.brainstorm") return brainstormIdeas({ query: String(args.query), context: Array.isArray(args.context) ? args.context as string[] : undefined, maximum: args.maximum as number | undefined });
			if (entry.name === "analysis.scorecard") return buildScorecard(String(args.id), args.metrics as never);
			if (entry.name === "analysis.calibrate") return calibrateConfidence(args.values as never, args.bins as number | undefined);
			if (entry.name === "analysis.replay") return replayEvaluation(args.cases as never);
			if (entry.name === "analysis.trajectory") return buildTrajectory(String(args.id), args.events as never, args.maximumEvents as number | undefined);
			if (entry.name === "analysis.route.sources") return routeMultiSourceQuery({ tenantId: scopedTenant(context, args), query: String(args.query), sources: args.sources as never, maximumSources: args.maximumSources as number | undefined });
			if (entry.name === "analysis.route.brains") return routeMultiBrainQuery({ tenantId: scopedTenant(context, args), query: String(args.query), brains: args.brains as never, maximumBrains: args.maximumBrains as number | undefined });
			if (entry.name === "analysis.diagnose") return diagnoseRetrieval({ query: String(args.query), tenantId: scopedTenant(context, args), brainId: scopedBrain(context, args), candidates: args.candidates as never });
			if (entry.name === "analysis.anomaly") return detectAnomalies((args.records as Array<{ tenantId: string; brainId: string }>).filter((record) => record.tenantId === (context.tenantId ?? "local") && (!context.brainId || record.brainId === context.brainId)) as never);
			if (entry.name === "analysis.recall") return recallMemories(args.records as never, { tenantId: scopedTenant(context, args), brainId: scopedBrain(context, args), query: String(args.query), limit: args.limit as number | undefined });
			if (entry.name === "analysis.forget") return forgetMemory(args.records as never, { tenantId: scopedTenant(context, args), brainId: scopedBrain(context, args), id: String(args.id) });
			if (entry.name === "analysis.contributor") return captureContributorQuery({ id: String(args.id), tenantId: scopedTenant(context, args), brainId: scopedBrain(context, args), query: String(args.query), consent: args.consent === true });
			if (entry.name === "maintenance.propose") return proposeSelfMaintenance({ tenantId: scopedTenant(context, args), brainId: scopedBrain(context, args), findings: args.findings as string[], dryRun: args.dryRun as boolean | undefined });
			if (entry.name === "skills.list") return createPinnedSkillRegistry().list();
			if (entry.name === "skills.resolve") return createPinnedSkillRegistry().resolve(String(args.id), String(args.agent) as never, args.version as string | undefined);
			if (entry.name === "skills.push-context") return createPinnedSkillRegistry().pushContext({ agent: String(args.agent) as never, query: String(args.query), citations: args.citations as string[], confidence: Number(args.confidence), minimumConfidence: args.minimumConfidence as number | undefined });
			if (entry.name === "skills.feedback") {
				const feedback = { id: args.id as string | undefined, tenantId: context.tenantId, brainId: context.brainId, skillId: String(args.skillId), version: args.version as string | undefined, agent: String(args.agent), outcome: String(args.outcome) as "used" | "volunteered" | "rejected", confidence: args.confidence as number | undefined };
				return dependencies.store ? recordSkillFeedback(dependencies.store, feedback) : createPinnedSkillRegistry().recordFeedback({ skillId: feedback.skillId, agent: feedback.agent as never, outcome: feedback.outcome, confidence: feedback.confidence });
			}
			if (entry.name === "skills.feedback.list") return listSkillFeedback(dependency(dependencies.store, "skills"), { tenantId: context.tenantId, brainId: context.brainId, skillId: args.skillId as string | undefined, limit: args.limit as number | undefined });
			if (entry.name === "skills.propose") return createPinnedSkillRegistry().installProposal(String(args.id), String(args.agent) as never, args.version as string | undefined);
			if (entry.name === "skills.optimizer-propose") return createPinnedSkillRegistry().optimizerProposal({ skillId: String(args.skillId), version: String(args.version), evidence: String(args.evidence), expectedImprovement: String(args.expectedImprovement) });
			if (entry.name === "security.check" || entry.name === "integrity.check") return { repository: await (dependencies.repository as unknown as { verify(): Promise<unknown> }).verify(), tenantId: controlContext.tenantId, status: "checked" };
			if (entry.name === "cache.inspect") {
				const requestedBrainId = typeof args.brainId === "string" ? args.brainId : context.brainId ?? null;
				const rows = await dependency(dependencies.store, "cache").query<{ count: number | string }>("SELECT count(*) AS count FROM brain_cache_entries WHERE tenant_id = $1 AND ($2::text IS NULL OR brain_id = $2)", [controlContext.tenantId, requestedBrainId]);
				return { tenantId: controlContext.tenantId, brainId: requestedBrainId, entries: Number(rows[0]?.count ?? 0) };
			}
			const control = dependency(dependencies.controlPlane, "control-plane");
			if (entry.name === "admin.dashboard") return control.dashboard(controlContext);
			if (entry.name === "admin.audit") return control.listAudit(controlContext, Number(args.limit ?? 100));
			if (entry.name === "admin.audit.page") return control.listAuditPage(controlContext, Number(args.limit ?? 100), args.after as string | undefined);
			if (entry.name === "admin.user.create") return control.createUser(controlContext, { id: String(args.id) });
			if (entry.name === "admin.tenant.create") return control.createTenant(controlContext, { id: String(args.id), name: String(args.name), ownerUserId: String(args.ownerUserId) });
			if (entry.name === "admin.brain.create") return control.createBrain(controlContext, { id: String(args.id), name: String(args.name), canonicalRemote: args.canonicalRemote as string | undefined });
			if (entry.name === "admin.membership.grant") return control.grantMembership(controlContext, { userId: String(args.userId), brainId: args.brainId as string | undefined, role: String(args.role) as "member" | "admin" | "owner", visibilityLabels: Array.isArray(args.visibilityLabels) ? args.visibilityLabels as string[] : undefined });
			if (entry.name === "admin.group.create") return control.createGroup(controlContext, { id: String(args.id), name: String(args.name) });
			if (entry.name === "admin.group.member-add") return control.addGroupMember(controlContext, { groupId: String(args.groupId), userId: String(args.userId) });
			if (entry.name === "admin.visibility.grant") return control.grantVisibility(controlContext, { brainId: String(args.brainId), subjectType: String(args.subjectType) as "user" | "group" | "tenant", subjectId: String(args.subjectId), label: String(args.label) });
			if (entry.name === "admin.source.register") return control.registerSource(controlContext, { id: String(args.id), brainId: String(args.brainId), version: String(args.version), kind: String(args.kind), compatibility: args.compatibility as Record<string, unknown> | undefined });
			if (entry.name === "admin.oauth-client.create") return control.registerOAuthClient(controlContext, { id: String(args.id), name: String(args.name), redirectUris: args.redirectUris as string[], scopes: args.scopes as never, publicClient: args.publicClient as boolean | undefined, clientSecret: args.clientSecret as string | undefined });
			if (entry.name === "admin.oauth-client.revoke") {
				const id = String(args.id);
				return new DurableAdminActionService(dependency(dependencies.store, "admin actions")).execute({ ...controlContext, idempotencyKey: String(args.idempotencyKey), confirmation: String(args.confirmation) }, { action: entry.name, targetId: id, confirmation: String(args.confirmation), resolve: async () => (await dependencies.store!.query<{ id: string }>("SELECT id FROM brain_oauth_clients WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL", [id, controlContext.tenantId])).length > 0, perform: async () => { await control.revokeOAuthClient(controlContext, id); return { id, revoked: true }; } });
			}
			if (entry.name === "admin.token.create") {
				const expiresAt = typeof args.expiresAt === "string" ? new Date(args.expiresAt) : undefined;
				if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("invalid token expiry");
				return createPersonalAccessToken(dependency(dependencies.store, "tokens"), { name: String(args.name), scopes: args.scopes as never, tenantId: controlContext.tenantId, userId: args.userId as string | undefined, ...(expiresAt ? { expiresAt } : {}) });
			}
			if (entry.name === "admin.token.list") return listPersonalAccessTokens(dependency(dependencies.store, "tokens"), controlContext.tenantId);
			if (entry.name === "admin.token.revoke") {
				const id = String(args.id);
				return new DurableAdminActionService(dependency(dependencies.store, "admin actions")).execute({ ...controlContext, idempotencyKey: String(args.idempotencyKey), confirmation: String(args.confirmation) }, { action: entry.name, targetId: id, confirmation: String(args.confirmation), resolve: async () => (await dependencies.store!.query<{ id: string }>("SELECT id FROM brain_access_tokens WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL", [id, controlContext.tenantId])).length > 0, perform: async () => { await revokePersonalAccessToken(dependency(dependencies.store, "tokens"), id, controlContext.tenantId); return { id, revoked: true }; } });
			}
			if (entry.name === "sources.list") return control.listSources(controlContext, args.brainId as string | undefined);
			if (entry.name === "sources.enable") {
				const id = String(args.id);
				const enabled = args.enabled === true;
				return new DurableAdminActionService(dependency(dependencies.store, "admin actions")).execute({ ...controlContext, idempotencyKey: String(args.idempotencyKey), confirmation: String(args.confirmation) }, { action: entry.name, targetId: id, confirmation: String(args.confirmation), resolve: async () => (await dependencies.store!.query<{ id: string }>("SELECT id FROM brain_source_registrations WHERE id = $1 AND tenant_id = $2 AND enabled IS DISTINCT FROM $3", [id, controlContext.tenantId, enabled])).length > 0, perform: async () => { await control.setSourceEnabled(controlContext, id, enabled); return { id, enabled }; } });
			}
			if (entry.name === "auth.session.create") return control.createWebSession(controlContext, String(args.userId));
			if (entry.name === "auth.session.revoke") return control.revokeWebSession(controlContext, String(args.sessionId));
			if (entry.name === "quota.consume") return control.consumeQuota(controlContext, { operation: String(args.operation), units: Number(args.units), limit: Number(args.limit), windowMs: Number(args.windowMs) });
			if (entry.name === "agent.start") return control.createAgentRun(controlContext, { brainId: String(args.brainId), agent: String(args.agent), operation: String(args.operation), baseCommit: String(args.baseCommit), policy: args.policy as never, plannedPaths: args.plannedPaths as string[] });
			if (entry.name === "agent.status") return control.getAgentRun(controlContext, String(args.id));
			if (entry.name === "agent.update") return control.updateAgentRun(controlContext, String(args.id), { status: String(args.status) as never, proposal: args.proposal as never, result: args.result as never, error: args.error as string | undefined });
			if (entry.name === "schema.upgrade.plan") return control.planSchemaUpgrade(controlContext, { brainId: String(args.brainId), fromVersion: String(args.fromVersion), toVersion: String(args.toVersion), changes: args.changes as never });
			if (entry.name === "schema.upgrade.approve") return control.approveSchemaUpgrade(controlContext, String(args.id));
			if (entry.name === "schema.upgrade.apply") return control.setSchemaUpgradeStatus(controlContext, String(args.id), "applied");
			if (entry.name === "rollback.record") return control.recordRollback(controlContext, { brainId: String(args.brainId), runId: args.runId as string | undefined, targetKind: String(args.targetKind), targetId: String(args.targetId), rollbackRef: String(args.rollbackRef), metadata: args.metadata as Record<string, unknown> | undefined });
			if (entry.name === "migration.drill") return control.recordMigrationDrill(controlContext, { brainId: context.brainId ?? "local", stage: String(args.stage), evidence: { legacyRetentionRequired: true } });
			throw new Error("operation requires an explicit application handler");
		} });
	}
	return registry;
}
