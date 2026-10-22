import { isOwnerMetadataOperation } from "./operation-registry";
import { expandLocalQuery } from "./hybrid";
import { RUNTIME_OPERATION_CATALOG, executeRuntimeOperation } from "./runtime-operations";
import { LOCAL_INGESTION_CATALOG, executeLocalIngestion } from "./local-ingestion";
import { enqueueReminder, listReminders } from "./reminders";
import { prepareMeeting, getMeetingPreparation } from "./meeting-preparation";
import { putOpenLoop, setOpenLoopStatus, getOpenLoop, listOpenLoops } from "./open-loops";
import { isPrimaryEvidence } from "./evidence-contract";
import { applyRelationshipProposal } from "./maintenance-approval";
import { maintenanceProposals, dismissMaintenanceProposal } from "./maintenance-scan";
import { startExecution, executionStatus, listExecutions, cancelExecution } from "./catalog-execution";
import { ingestConversation } from "./conversation-ingestion";
import { RUNTIME_BACKUP_CATALOG, runtimeBackupOperations } from "../runtime-backup";
import type { Config } from "../config";
import { GoogleApiError } from "../sources/google-api";
import { connectGoogleAccount } from "./google-setup";
import type { authorizeGoogleAccount } from "../sources/google-authorization";
import type { GoogleCredential } from "../sources/google-oauth";
import { addGoogleSource, googleSourceStatus, enqueueGoogleSync, setGoogleSourceEnabled, scheduleGoogleSource } from "./google-jobs";
import type { GoogleCredentialAccess } from "../sources/google-account-client";
import type { GoogleBoundary } from "../sources/google-pages";
import { putEntity, putRelationship, resolveEntity, queryRelationships, entityReviews, resolveEntityReview } from "./entity-relationships";
import { createAnswer, getAnswer, definePin, pinStatus, enqueuePinRefresh, answerFeedback, resetAnswerFeedback } from "./maintained-answers";
import { enqueueClaudeTranscript, type ClaudeTranscriptInput } from "./claude-transcript-capture";
import { stageCaptureTurn, enqueueCaptureTurn, type CaptureTurn } from "./memory-capture";
import { deliverContext } from "./context-delivery";
import { remember, recall, correct, forget, memoryHistory, memoryIsActive, type MemoryWriteInput, type MemoryCorrectInput, type MemoryForgetInput } from "./memory";
import { parseFrontmatter } from "../archive";
import { validateSearchOptions } from "./search";
import type { SearchOptions } from "../model";
import type { BrainStore } from "./store";
import type { DurableControlPlane } from "./control-plane";
import { createPinnedSkillRegistry } from "../skills";
import { listSkillFeedback, recordSkillFeedback } from "./skill-feedback";
import { diagnoseProvider } from "./providers";
import { createJobSchedule, enqueueJob, listJobSchedules, listJobs, cancelJob } from "./jobs";
import { createPersonalAccessToken, listPersonalAccessTokens, revokePersonalAccessToken } from "./access-tokens";
import { DurableAdminActionService } from "./admin";
import { ensureCurrentBrainProjection, indexBrainRepository, searchVerifiedHybridBrainRepository, relatedBrainPages } from "./pglite-indexer";
import { analyzeCodeDocument, brainstormIdeas, buildScorecard, buildTrajectory, calibrateConfidence, captureContributorQuery, detectAnomalies, diagnoseRetrieval, forgetMemory, linkDocumentation, recallMemories, replayEvaluation, routeMultiBrainQuery, routeMultiSourceQuery } from "./advanced";
import { discoverAdvancedFeatures, proposeSelfMaintenance, runAdvancedEvaluation } from "./advanced-evaluation";
import { createBrainRepositoryOperationRegistry, OperationRegistry, type JsonSchema, type OperationContext } from "./operation-registry";
import { brainRepositoryOperationNames } from "./operations";

export interface CatalogDependencies {
 backupConfig?: Config;
 googleCredentials?: GoogleCredentialAccess & { put?: (credential: GoogleCredential) => Promise<void> };
 googleAuthorization?: typeof authorizeGoogleAccount;
	transcriptionProvider?: import("./providers").TranscriptionProvider;
	stateRoot?: string;
	generationProvider?: { generate(prompt: string): Promise<string> };
	repository: Parameters<typeof createBrainRepositoryOperationRegistry>[0];
	store?: BrainStore;
	controlPlane?: DurableControlPlane;
	embeddingProvider?: { model: { id: string; dimensions: number; fingerprint?: string }; embed(texts: string[]): Promise<number[][]> };
	rerankerProvider?: { rerank(query: string, documents: Array<{ id: string; text: string }>): Promise<Array<{ id: string; score: number }>> };
	handlers?: Partial<Record<CatalogOperationName, (context: OperationContext, input: Record<string, unknown>) => Promise<unknown>>>;
}

export const CONTROL_OPERATION_CATALOG = [
 ...RUNTIME_BACKUP_CATALOG,
 ...LOCAL_INGESTION_CATALOG,
 ...RUNTIME_OPERATION_CATALOG,
 { name: "reminders.enqueue", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["id", "expectedRevision"], properties: { id: { type: "string" }, expectedRevision: { type: "string" } }, additionalProperties: false } },
 { name: "reminders.list", scope: "read", boundary: "remote-safe", schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, after: { type: "string" } }, additionalProperties: false } },
 { name: "meetings.prepare", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["idempotencyKey"], properties: { idempotencyKey: { type: "string" }, meetingId: { type: "string" }, title: { type: "string" }, participants: { type: "array", items: { type: "string" }, maxItems: 8 }, since: { type: "string" }, maximumEvidence: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false } },
 { name: "meetings.get", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
 { name: "loops.put", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["title", "evidence", "idempotencyKey"], properties: { id: { type: "string" }, expectedRevision: { type: "string" }, idempotencyKey: { type: "string" }, title: { type: "string" }, participants: { type: "array", items: { type: "string" } }, dueAt: { type: "string" }, evidence: { type: "array", items: { type: "object" } }, visibility: { type: "array", items: { type: "string" } } }, additionalProperties: false } },
 { name: "loops.status", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["id", "expectedRevision", "status", "idempotencyKey"], properties: { id: { type: "string" }, expectedRevision: { type: "string" }, idempotencyKey: { type: "string" }, status: { type: "string", enum: ["open", "done", "cancelled"] } }, additionalProperties: false } },
 { name: "loops.get", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
 { name: "loops.list", scope: "read", boundary: "remote-safe", schema: { type: "object", properties: { status: { type: "string", enum: ["open", "done", "cancelled"] }, participant: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }, after: { type: "string" }, includeStale: { type: "boolean" } }, additionalProperties: false } },

 {"name":"execution.start","scope":"admin","boundary":"local-only","schema":{"type":"object","required":["idempotencyKey","steps"],"properties":{"idempotencyKey":{"type":"string"},"steps":{"type":"array","items":{"type":"object"}},"budget":{"type":"object"}},"additionalProperties":false}},
 {"name":"execution.status","scope":"admin","boundary":"local-only","schema":{"type":"object","required":["id"],"properties":{"id":{"type":"string"},"includeHistoricalResults":{"type":"boolean"}},"additionalProperties":false}},
 {"name":"execution.list","scope":"admin","boundary":"local-only","schema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100},"before":{"type":"string"}},"additionalProperties":false}},
 {"name":"execution.cancel","scope":"admin","boundary":"local-only","schema":{"type":"object","required":["id"],"properties":{"id":{"type":"string"}},"additionalProperties":false}},
 { name: "sources.conversation.ingest", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["conversation"], properties: { conversation: { type: "object" }, dryRun: { type: "boolean" } }, additionalProperties: false } },
 { name: "google.accounts.connect", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["clientFile", "email", "boundaries"], properties: { clientFile: { type: "string" }, email: { type: "string" }, boundaries: { type: "array", items: { type: "object" } } }, additionalProperties: false } },

 { name: "google.sources.add", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["boundary"], properties: { boundary: { type: "object" } }, additionalProperties: false } },
 { name: "google.sources.enable", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["id", "expectedRevision", "enabled", "idempotencyKey"], properties: { id: { type: "string" }, expectedRevision: { type: "string" }, enabled: { type: "boolean" }, idempotencyKey: { type: "string" } }, additionalProperties: false } },
 { name: "google.sources.schedule", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["id", "expectedRevision", "intervalSeconds", "enabled", "idempotencyKey"], properties: { id: { type: "string" }, expectedRevision: { type: "string" }, intervalSeconds: { type: "integer", minimum: 60, maximum: 86400 }, enabled: { type: "boolean" }, idempotencyKey: { type: "string" }, maximumPages: { type: "integer", minimum: 1, maximum: 1000 }, runImmediately: { type: "boolean" } }, additionalProperties: false } },
 { name: "google.sources.status", scope: "admin", boundary: "local-only", schema: { type: "object", properties: {}, additionalProperties: false } },
 { name: "google.sources.sync", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["id", "expectedRevision", "idempotencyKey"], properties: { id: { type: "string" }, expectedRevision: { type: "string" }, idempotencyKey: { type: "string" }, maximumPages: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false } },

 {"name": "entities.put", "scope": "write", "boundary": "remote-safe", "schema": {"type": "object", "required": ["idempotencyKey", "name", "entityType", "aliases", "evidence", "confidence"], "properties": {"id": {"type": "string"}, "expectedRevision": {"type": "string"}, "idempotencyKey": {"type": "string"}, "visibility": {"type": "array", "items": {"type": "string"}}, "evidence": {"type": "array", "items": {"type": "object"}}, "confidence": {"type": "number", "minimum": 0, "maximum": 1}, "validFrom": {"type": "string"}, "validUntil": {"type": "string"}, "name": {"type": "string"}, "entityType": {"type": "string"}, "aliases": {"type": "array", "items": {"type": "string"}}}, "additionalProperties": false}},
 {"name": "relationships.put", "scope": "write", "boundary": "remote-safe", "schema": {"type": "object", "required": ["idempotencyKey", "fromId", "toId", "relationshipType", "evidence", "confidence"], "properties": {"id": {"type": "string"}, "expectedRevision": {"type": "string"}, "idempotencyKey": {"type": "string"}, "visibility": {"type": "array", "items": {"type": "string"}}, "evidence": {"type": "array", "items": {"type": "object"}}, "confidence": {"type": "number", "minimum": 0, "maximum": 1}, "validFrom": {"type": "string"}, "validUntil": {"type": "string"}, "fromId": {"type": "string"}, "toId": {"type": "string"}, "relationshipType": {"type": "string"}}, "additionalProperties": false}},
 {"name": "entities.resolve", "scope": "read", "boundary": "remote-safe", "schema": {"type": "object", "required": ["query"], "properties": {"query": {"type": "string"}}, "additionalProperties": false}},
 { name: "entities.review.resolve", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["id", "expectedRevision", "idempotencyKey", "decision"], properties: { id: { type: "string" }, expectedRevision: { type: "string" }, idempotencyKey: { type: "string" }, decision: { type: "string", enum: ["merge", "separate", "reject"] }, targetId: { type: "string" } }, additionalProperties: false } },
 {"name": "entities.reviews", "scope": "admin", "boundary": "local-only", "schema": {"type": "object", "required": [], "properties": {"cursor": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}}, "additionalProperties": false}},
 {"name": "relationships.query", "scope": "read", "boundary": "remote-safe", "schema": {"type": "object", "required": ["from"], "properties": {"from": {"type": "string"}, "to": {"type": "string"}, "maximumDepth": {"type": "integer", "minimum": 1, "maximum": 3}, "maximumResults": {"type": "integer", "minimum": 1, "maximum": 100}, "direction": {"type": "string", "enum": ["outbound", "inbound", "both"]}, "relationshipTypes": {"type": "array", "items": {"type": "string"}}}, "additionalProperties": false}},
	{ name: "context.deliver", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["query"], properties: { query: { type: "string" }, maximumTokens: { type: "integer", minimum: 100, maximum: 2000 }, timeoutMs: { type: "integer", minimum: 50, maximum: 1800 } }, additionalProperties: false } },
	{ name: "memory.remember", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["idempotencyKey", "text", "provenance"], properties: { idempotencyKey: { type: "string" }, text: { type: "string" }, provenance: { type: "object" }, validFrom: { type: "string" }, validUntil: { type: "string" }, visibility: { type: "array", items: { type: "string" } } }, additionalProperties: false } },
	{ name: "memory.correct", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["id", "expectedRevision", "idempotencyKey", "text", "provenance"], properties: { ...{ idempotencyKey: { type: "string" }, text: { type: "string" }, provenance: { type: "object" }, validFrom: { type: "string" }, validUntil: { type: "string" }, visibility: { type: "array", items: { type: "string" } } }, id: { type: "string" }, expectedRevision: { type: "string" } }, additionalProperties: false } },
	{ name: "memory.forget", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["id", "expectedRevision", "idempotencyKey"], properties: { id: { type: "string" }, expectedRevision: { type: "string" }, idempotencyKey: { type: "string" }, reason: { type: "string" } }, additionalProperties: false } },
	{ name: "capture.claude.enqueue", scope: "write", boundary: "local-only", schema: { type: "object", required: ["installationId", "sessionId", "transcriptPath"], properties: { installationId: { type: "string" }, sessionId: { type: "string" }, transcriptPath: { type: "string" } }, additionalProperties: false } },
	{ name: "capture.stage", scope: "write", boundary: "local-only", schema: { type: "object", required: ["installationId", "sessionId", "turnId", "prompt"], properties: { installationId: { type: "string" }, sessionId: { type: "string" }, turnId: { type: "string" }, prompt: { type: "string" } }, additionalProperties: false } },
	{ name: "capture.enqueue", scope: "write", boundary: "local-only", schema: { type: "object", required: ["installationId", "sessionId", "turnId"], properties: { installationId: { type: "string" }, sessionId: { type: "string" }, turnId: { type: "string" } }, additionalProperties: false } },
	{ name: "memory.recall", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false } },
	{ name: "memory.history", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["id"], properties: { id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500 } }, additionalProperties: false } },
	{ name: "projection.rebuild", scope: "admin", boundary: "local-only", schema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "retrieval.search", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }, expand: { type: "boolean" }, rerank: { type: "boolean" }, options: { type: "object" } }, additionalProperties: false } },
	{ name: "retrieval.get", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
	{ name: "retrieval.related", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
 {"name": "answers.get", "scope": "read", "boundary": "remote-safe", "schema": {"type": "object", "required": ["answerId"], "properties": {"answerId": {"type": "string"}}, "additionalProperties": false}},
 {"name": "answers.feedback", "scope": "write", "boundary": "remote-safe", "schema": {"type": "object", "required": ["answerId", "rating", "idempotencyKey"], "properties": {"answerId": {"type": "string"}, "rating": {"type": "integer", "minimum": -1, "maximum": 1}, "idempotencyKey": {"type": "string"}}, "additionalProperties": false}},
 {"name": "answers.feedback.reset", "scope": "write", "boundary": "remote-safe", "schema": {"type": "object", "required": ["answerId"], "properties": {"answerId": {"type": "string"}}, "additionalProperties": false}},
 {"name": "questions.put", "scope": "write", "boundary": "remote-safe", "schema": {"type": "object", "required": ["question", "idempotencyKey"], "properties": {"question": {"type": "string"}, "idempotencyKey": {"type": "string"}, "id": {"type": "string"}, "expectedRevision": {"type": "string"}, "visibility": {"type": "array", "items": {"type": "string"}}}, "additionalProperties": false}},
 {"name": "questions.get", "scope": "read", "boundary": "remote-safe", "schema": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}, "additionalProperties": false}},
 {"name": "questions.refresh", "scope": "write", "boundary": "remote-safe", "schema": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}, "additionalProperties": false}},
 {"name": "questions.list", "scope": "read", "boundary": "remote-safe", "schema": {"type": "object", "required": [], "properties": {}, "additionalProperties": false}},
	{ name: "reasoning.answer", scope: "read", boundary: "remote-safe", schema: { type: "object", required: ["question"], properties: { question: { type: "string" } }, additionalProperties: false } },
	{ name: "models.diagnose", scope: "read", boundary: "local-only", schema: { type: "object", required: ["endpoint"], properties: { endpoint: { type: "string" }, privacy: { type: "string", enum: ["local", "hosted"] } }, additionalProperties: false } },
	{ name: "models.activate", scope: "write", boundary: "local-only", schema: { type: "object", required: ["kind", "fingerprint"], properties: { kind: { type: "string" }, fingerprint: { type: "string" }, descriptor: { type: "object" } }, additionalProperties: false } },
	{ name: "jobs.run-one", scope: "admin", boundary: "local-only", schema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "jobs.list", scope: "read", boundary: "remote-safe", schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false } },
	{ name: "jobs.enqueue", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["type", "payload"], properties: { type: { type: "string" }, payload: { type: "object" }, availableAt: { type: "string" }, dependencyIds: { type: "array", items: { type: "string" } }, dependencyFailurePolicy: { type: "string", enum: ["cancel", "dead-letter", "degraded"] }, idempotencyKey: { type: "string" } }, additionalProperties: false } },
	{ name: "jobs.cancel", scope: "write", boundary: "remote-safe", schema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
	{ name: "jobs.schedule", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["type", "payload", "intervalSeconds"], properties: { type: { type: "string" }, payload: { type: "object" }, intervalSeconds: { type: "integer", minimum: 1 }, nextRunAt: { type: "string" } }, additionalProperties: false } },
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
 { name: "maintenance.scan", scope: "admin", boundary: "local-only", schema: { type: "object", properties: { maximumItems: { type: "integer", minimum: 1, maximum: 500 }, dryRun: { type: "boolean" } }, additionalProperties: false } },
 { name: "maintenance.proposals", scope: "admin", boundary: "local-only", schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, after: { type: "string" } }, additionalProperties: false } },
 { name: "maintenance.accept", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["id", "expectedRevision", "idempotencyKey"], properties: { id: { type: "string" }, expectedRevision: { type: "string" }, idempotencyKey: { type: "string" } }, additionalProperties: false } },
 { name: "maintenance.dismiss", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["id", "expectedRevision"], properties: { id: { type: "string" }, expectedRevision: { type: "string" } }, additionalProperties: false } },
	{ name: "maintenance.propose", scope: "write", boundary: "local-only", schema: { type: "object", required: ["tenantId", "brainId", "findings"], properties: { tenantId: { type: "string" }, brainId: { type: "string" }, findings: { type: "array", items: { type: "string" } }, dryRun: { type: "boolean" } }, additionalProperties: false } },
] as const satisfies ReadonlyArray<{ name: string; scope: "read" | "write" | "admin"; boundary: "remote-safe" | "local-only" | "confined-upload"; schema: JsonSchema }>;

export type CatalogOperationName = (typeof CONTROL_OPERATION_CATALOG)[number]["name"];
export const ALL_OPERATION_NAMES = [...brainRepositoryOperationNames, ...CONTROL_OPERATION_CATALOG.map((entry) => entry.name)] as const;

function dependency<T>(value: T | undefined, name: string): T { if (!value) throw Object.assign(new Error(`${name} operation dependency is unavailable`), { code: "operation_dependency_unavailable", retryable: false, suggestedFix: "Start the configured local service, or supply the required repository, operational store and local provider configuration." }); return value; }
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
            if (context.allowedAccessLabels !== undefined && isOwnerMetadataOperation(entry.name)) throw Object.assign(new Error("Operational metadata requires owner administration access."), { code: "owner_access_required", retryable: false, suggestedFix: "Use the unrestricted local owner CLI for jobs, sources, agent runs, cache, and skill usage administration." });
			const custom = dependencies.handlers?.[entry.name];
			if (custom) return custom(context, input as Record<string, unknown>);
			const args = input as Record<string, unknown>;
            if (RUNTIME_OPERATION_CATALOG.some((operation) => operation.name === entry.name)) return executeRuntimeOperation({ repository: dependencies.repository as import("./repository").BrainRepository, store: dependencies.store, config: dependencies.backupConfig, embeddingProvider: dependencies.embeddingProvider, transcriptionProvider: dependencies.transcriptionProvider }, context, entry.name, args);
            if (LOCAL_INGESTION_CATALOG.some((operation) => operation.name === entry.name)) return executeLocalIngestion({ repository: dependencies.repository as import("./repository").BrainRepository, store: dependency(dependencies.store, "local ingestion") }, context, entry.name, args);

            if (entry.name === "projection.rebuild" || entry.name === "retrieval.search" || entry.name === "retrieval.related" || entry.name === "reasoning.answer") {
                const repository = dependencies.repository as import("./repository").BrainRepository;
                const snapshot = await repository.snapshot() as Awaited<ReturnType<typeof repository.snapshot>> & { tenantId?: string };
                if (context.tenantId && context.tenantId !== (snapshot.tenantId ?? "local") || context.brainId && context.brainId !== snapshot.brainId) throw new Error("brain scope is not authorized");
                if (entry.name === "projection.rebuild") {
                    if (context.allowedAccessLabels !== undefined) throw new Error("owner administration access is required");
                    context.signal?.throwIfAborted();
                    return indexBrainRepository(dependency(dependencies.store, "projection"), repository);
                }
                context.signal?.throwIfAborted();
                await ensureCurrentBrainProjection(dependency(dependencies.store, "retrieval"), repository);
                context.signal?.throwIfAborted();
            }

            if (entry.name.startsWith("execution.")) {
             const execution = { store: dependency(dependencies.store, "execution"), repository: dependencies.repository as import("./repository").BrainRepository, managedWrites: () => dependencies.backupConfig?.automation?.managedWrites === true };
             if (entry.name === "execution.start") return startExecution(execution, context, args as unknown as Parameters<typeof startExecution>[2]);
             if (entry.name === "execution.status") return executionStatus(execution, context, args as unknown as Parameters<typeof executionStatus>[2]);
             if (entry.name === "execution.list") return listExecutions(execution, context, args as unknown as Parameters<typeof listExecutions>[2]);
             return cancelExecution(execution, context, String(args.id));
            }
            if (entry.name === "sources.conversation.ingest") return ingestConversation({ repository: dependencies.repository as import("./repository").BrainRepository, store: dependency(dependencies.store, "conversation ingestion") }, context, args as { conversation: unknown; dryRun?: boolean });
            if (entry.name.startsWith("backup.")) return runtimeBackupOperations(dependency(dependencies.backupConfig, "backup configuration")).find((operation) => operation.name === entry.name)!.execute(context, args);
			const controlContext = { principal: context.principal ?? "anonymous", tenantId: context.tenantId ?? "local", ...(context.brainId ? { brainId: context.brainId } : {}), scope: context.scope };
            if (entry.name === "google.accounts.connect") return connectGoogleAccount({ store: dependency(dependencies.store, "Google account setup"), repository: dependencies.repository as import("./repository").BrainRepository, credentials: dependencies.googleCredentials, authorize: dependencies.googleAuthorization }, context, args as unknown as Parameters<typeof connectGoogleAccount>[2]);
            if (entry.name.startsWith("google.sources.")) {
                const google = { store: dependency(dependencies.store, "Google ingestion"), repository: dependencies.repository as import("./repository").BrainRepository, credentials: dependencies.googleCredentials };
                if (entry.name === "google.sources.add") return addGoogleSource(google, context, args.boundary as GoogleBoundary);
                if (entry.name === "google.sources.status") return googleSourceStatus(google, context);
                if (entry.name === "google.sources.schedule") return scheduleGoogleSource(google, context, args as unknown as Parameters<typeof scheduleGoogleSource>[2]);
                if (entry.name === "google.sources.enable") return setGoogleSourceEnabled(google, context, args as unknown as Parameters<typeof setGoogleSourceEnabled>[2]);
                return enqueueGoogleSync(google, context, args as unknown as Parameters<typeof enqueueGoogleSync>[2]);
            }
            if (entry.name.startsWith("reminders.")) {
                const repository = dependencies.repository as import("./repository").BrainRepository, store = dependency(dependencies.store, "reminders");
                return entry.name === "reminders.enqueue" ? enqueueReminder(repository, store, context, args as { id: string; expectedRevision: string }) : listReminders(repository, store, context, args);
            }
            if (entry.name.startsWith("meetings.")) {
                const repository = dependencies.repository as import("./repository").BrainRepository;
                if (entry.name === "meetings.get") return getMeetingPreparation(repository, context, String(args.id));
                return prepareMeeting(repository, dependency(dependencies.store, "meeting preparation"), context, args as unknown as Parameters<typeof prepareMeeting>[3], { embeddingProvider: dependencies.embeddingProvider, rerankerProvider: dependencies.rerankerProvider });
            }
            if (entry.name.startsWith("loops.")) {
                const repository = dependencies.repository as import("./repository").BrainRepository;
                if (entry.name === "loops.put") return putOpenLoop(repository, context, args as unknown as Parameters<typeof putOpenLoop>[2]);
                if (entry.name === "loops.status") return setOpenLoopStatus(repository, context, args as unknown as Parameters<typeof setOpenLoopStatus>[2]);
                if (entry.name === "loops.get") return getOpenLoop(repository, context, String(args.id));
                return listOpenLoops(repository, context, args as Parameters<typeof listOpenLoops>[2]);
            }
            if (entry.name.startsWith("entities.") || entry.name.startsWith("relationships.")) {
                const repository = dependencies.repository as import("./repository").BrainRepository;
                if (entry.name === "entities.put") return putEntity(repository, context, args as unknown as Parameters<typeof putEntity>[2]);
                if (entry.name === "relationships.put") return putRelationship(repository, context, args as unknown as Parameters<typeof putRelationship>[2]);
                if (entry.name === "entities.resolve") return resolveEntity(repository, context, String(args.query));
                if (entry.name === "entities.reviews") return entityReviews(repository, context, args as { cursor?: string; limit?: number });
                if (entry.name === "entities.review.resolve") return resolveEntityReview(repository, context, args as unknown as Parameters<typeof resolveEntityReview>[2]);
                return queryRelationships(repository, context, args as unknown as Parameters<typeof queryRelationships>[2]);
            }
			if (entry.name === "context.deliver") return deliverContext(registry, context, args as unknown as { query: string; maximumTokens?: number; timeoutMs?: number });
			if (entry.name === "capture.stage" || entry.name === "capture.enqueue" || entry.name === "capture.claude.enqueue") {
				if (context.tenantId && context.tenantId !== "local") throw new Error("capture tenant is not authorized");
				const store = dependency(dependencies.store, "capture"), stateRoot = dependency(dependencies.stateRoot, "capture configuration");
				const identity = await (dependencies.repository as import("./repository").BrainRepository).getIdentity();
				if (context.brainId && context.brainId !== identity.brainId) throw new Error("capture brain is not authorized");
				if (entry.name === "capture.claude.enqueue") return enqueueClaudeTranscript(store, stateRoot, args as unknown as ClaudeTranscriptInput, identity.brainId);
				return entry.name === "capture.stage" ? stageCaptureTurn(store, stateRoot, args as unknown as CaptureTurn, identity.brainId) : enqueueCaptureTurn(store, stateRoot, args as unknown as CaptureTurn, identity.brainId);
			}
			if (entry.name.startsWith("memory.")) {
				const repository = dependencies.repository as import("./repository").BrainRepository;

				if (entry.name === "memory.recall") return recall(repository, context, args as unknown as { query: string; limit?: number });
				if (entry.name === "memory.history") return memoryHistory(repository, context, String(args.id), args.limit as number | undefined);
				const result = entry.name === "memory.remember" ? await remember(repository, context, args as unknown as MemoryWriteInput) : entry.name === "memory.correct" ? await correct(repository, context, args as unknown as MemoryCorrectInput) : await forget(repository, context, args as unknown as MemoryForgetInput);
				if (dependencies.store) await indexBrainRepository(dependencies.store, repository);
				return result;
			}
            if (entry.name.startsWith("jobs.") && context.allowedAccessLabels !== undefined || (entry.name === "jobs.enqueue" || entry.name === "jobs.schedule") && context.scope !== "admin") throw new GoogleApiError("owner_access_required", 403, false);
			if (entry.name === "jobs.list") return listJobs(dependency(dependencies.store, "jobs"), Number(args.limit ?? 100), context.tenantId);
            if (entry.name === "jobs.enqueue") {
                const availableAt = typeof args.availableAt === "string" ? new Date(args.availableAt) : undefined;
                if (availableAt && Number.isNaN(availableAt.getTime())) throw new Error("invalid job availability timestamp");
                return enqueueJob(dependency(dependencies.store, "jobs"), { type: String(args.type), payload: args.payload, tenantId: context.tenantId, availableAt, dependencyIds: Array.isArray(args.dependencyIds) ? args.dependencyIds as string[] : [], dependencyFailurePolicy: args.dependencyFailurePolicy as "cancel" | "dead-letter" | "degraded" | undefined, idempotencyKey: args.idempotencyKey as string | undefined });
            }
			if (entry.name === "jobs.cancel") return cancelJob(dependency(dependencies.store, "jobs"), String(args.id), context.tenantId);
			if (entry.name === "jobs.schedule") {
				const nextRunAt = typeof args.nextRunAt === "string" ? new Date(args.nextRunAt) : undefined;
				if (nextRunAt && Number.isNaN(nextRunAt.getTime())) throw new Error("invalid job schedule timestamp");
				return createJobSchedule(dependency(dependencies.store, "jobs"), { type: String(args.type), payload: args.payload, intervalSeconds: Number(args.intervalSeconds), tenantId: context.tenantId, ...(nextRunAt ? { nextRunAt } : {}) });
			}
			if (entry.name === "jobs.schedules") return listJobSchedules(dependency(dependencies.store, "jobs"), context.tenantId);
			if (entry.name === "retrieval.get" || entry.name === "retrieval.related") {
				const repository = dependencies.repository as unknown as Parameters<typeof searchVerifiedHybridBrainRepository>[1];
				const snapshot = await repository.snapshot();
				if (context.tenantId && context.tenantId !== (snapshot.tenantId ?? "local") || context.brainId && context.brainId !== snapshot.brainId) throw new Error("brain scope is not authorized");
				const page = snapshot.pages.find((page) => page.id === args.id && !page.deleted && !page.stale && memoryIsActive(page));
				if (!page || !isPrimaryEvidence(page) || context.allowedAccessLabels && (page.accessLabels ?? []).some((label) => !context.allowedAccessLabels!.includes(label))) throw new Error("document is unavailable");
				if (entry.name === "retrieval.related") return (await relatedBrainPages(dependency(dependencies.store, "retrieval"), page.path, snapshot.brainId, context.tenantId ?? "local", context.allowedAccessLabels, repository)).filter((related) => snapshot.pages.some((entry) => entry.id === related.id && !entry.deleted && !entry.stale && memoryIsActive(entry) && (context.allowedAccessLabels === undefined || (entry.accessLabels ?? []).every((label) => context.allowedAccessLabels!.includes(label)))));
				return { ...page, ...(await repository.readPage(snapshot, page.id)), commit: snapshot.commit };
			}
			if (entry.name === "retrieval.search") {
				const repository = dependencies.repository as unknown as Parameters<typeof searchVerifiedHybridBrainRepository>[1];
				const snapshot = await repository.snapshot();
				const options = (args.options ?? {}) as SearchOptions;
				validateSearchOptions(options);
				const limit = Number(args.limit ?? options.limit ?? 20);
				if (options.mode === "semantic" && !dependencies.embeddingProvider) return { query: String(args.query), results: [], degraded: true, diagnostics: ["Configure a local embedding provider."], requestedMode: "semantic", effectiveMode: "unavailable" };
				const hasFilters = ["provider", "project", "repository", "workspace", "role", "after", "before"].some((key) => options[key as keyof SearchOptions] !== undefined);
				const candidates = await searchVerifiedHybridBrainRepository(dependency(dependencies.store, "retrieval"), repository, String(args.query), { limit: hasFilters ? 100 : limit, mode: options.mode, expand: args.expand === true && options.mode !== "semantic", brainId: context.brainId ?? snapshot.brainId, tenantId: context.tenantId ?? "local", allowedAccessLabels: context.allowedAccessLabels, embeddingProvider: options.mode === "keyword" ? undefined : dependencies.embeddingProvider, rerankerProvider: options.mode === "keyword" && args.rerank !== true ? undefined : dependencies.rerankerProvider });
				const results = [];
				for (const candidate of candidates) {
					const content = (await repository.readPage(snapshot, candidate.citation.documentId)).content;
					const values = parseFrontmatter(content)?.values ?? {};
					const metadata = snapshot.pages.find((page) => page.id === candidate.citation.documentId)?.source?.provenance?.metadata ?? {};
					const field = (name: string) => String(values[name] ?? metadata[name] ?? "");
					if (["provider", "project", "repository", "workspace"].some((key) => options[key as keyof SearchOptions] && field(key) !== options[key as keyof SearchOptions])) continue;
					if (options.role && !new RegExp("^" + options.role + ":", "mi").test(candidate.verifiedText)) continue;
					const at = field("updated_at") || field("created_at");
					if (options.after && (!at || Date.parse(at) < Date.parse(options.after)) || options.before && (!at || Date.parse(at) > Date.parse(options.before))) continue;
					results.push({ ...candidate, metadata: values });
				}
				return { query: String(args.query), ...(args.expand === true && options.mode !== "semantic" ? { variants: expandLocalQuery(String(args.query)) } : {}), results: results.slice(0, limit) };
			}
            if (entry.name === "reasoning.answer" || entry.name.startsWith("answers.") || entry.name.startsWith("questions.")) {
                const repository = dependencies.repository as import("./repository").BrainRepository;
                const maintained = { store: dependency(dependencies.store, "answers"), repository, provider: dependencies.generationProvider, searchOptions: { embeddingProvider: dependencies.embeddingProvider, rerankerProvider: dependencies.rerankerProvider } };
                if (entry.name === "reasoning.answer") return createAnswer(maintained, context, String(args.question));
                if (entry.name === "answers.get") return getAnswer(maintained, context, String(args.answerId));
                if (entry.name === "answers.feedback") return answerFeedback(maintained, context, args as unknown as Parameters<typeof answerFeedback>[2]);
                if (entry.name === "answers.feedback.reset") return resetAnswerFeedback(maintained, context, String(args.answerId));
                if (entry.name === "questions.put") return definePin(maintained, context, args as unknown as Parameters<typeof definePin>[2]);
                if (entry.name === "questions.get") return pinStatus(maintained, context, String(args.id));
                if (entry.name === "questions.refresh") return enqueuePinRefresh(maintained, context, String(args.id));
                const pins = [];
                for (const page of (await repository.snapshot()).pages.filter((page) => !page.deleted && page.source?.type === "manas-pinned-question")) {
                    if (context.allowedAccessLabels && (page.accessLabels ?? []).some((label) => !context.allowedAccessLabels!.includes(label))) continue;
                    pins.push(await pinStatus(maintained, context, page.id));
                }
                return { questions: pins };
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
            if (["maintenance.scan", "maintenance.proposals", "maintenance.dismiss", "maintenance.accept"].includes(entry.name)) {
                const repository = dependencies.repository as import("./repository").BrainRepository;
                if (entry.name === "maintenance.proposals") return maintenanceProposals(repository, context, args as { limit?: number; after?: string });
                if (entry.name === "maintenance.accept") return applyRelationshipProposal(repository, context, args as { id: string; expectedRevision: string; idempotencyKey: string });
                if (entry.name === "maintenance.dismiss") return dismissMaintenanceProposal(repository, context, args as { id: string; expectedRevision: string });
                if (context.allowedAccessLabels !== undefined || context.scope !== "admin") throw new GoogleApiError("owner_access_required", 403, false);
                const snapshot = await repository.snapshot();
                if ((context.tenantId ?? "local") !== "local" || context.brainId && context.brainId !== snapshot.brainId) throw new GoogleApiError("owner_access_required", 403, false);
                return enqueueJob(dependency(dependencies.store, "maintenance"), { type: "maintenance-scan", tenantId: "local", payload: { brainId: snapshot.brainId, maximumItems: args.maximumItems ?? 100, dryRun: args.dryRun === true } });
            }
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
