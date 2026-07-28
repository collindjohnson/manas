import { createHash } from "node:crypto";
import { recordJobEvent, updateJobProgress, type BrainJob } from "./jobs";
import { assertJobBudget, IdempotencyLedger, classifyJobFailure, type JobBudget, type JobPrivacy } from "./job-policy";
import { recordAuditEvent } from "./audit";
import { indexBrainRepository } from "./pglite-indexer";
import { BrainRepository } from "./repository";
import type { BrainStore } from "./store";
import { buildTrajectory, detectAnomalies } from "./advanced";
import { runAdvancedEvaluation, proposeSelfMaintenance } from "./advanced-evaluation";
import { assertSchemaPack } from "./schema";
import { createPinnedSkillRegistry } from "../skills";
import { ArchiveMetadataExtractor, AudioTranscriptionExtractor, BinaryMetadataExtractor, extractLocalFile, ImageOcrExtractor, OfficeDocumentExtractor, PdfExtractor, PlainTextExtractor } from "../sources/extractors";
import { indexLocalEmbeddings } from "./local-embeddings";
import type { EmbeddingProvider, StructuredExtractionProvider, TranscriptionProvider } from "./providers";
import { createAuditQuarantineSink, createPgliteIngestionRunLifecycle, syncSource } from "../sources/sync";
import type { NormalizedDocument, SourceDescriptor } from "../sources/types";

export const PARITY_JOB_TYPES = [
	"indexing", "embedding", "extraction", "transcription", "source-synchronization", "entity-enrichment", "fact-extraction", "trajectories", "deduplication", "consolidation", "citation-repair", "backlink-reconciliation", "contradiction-analysis", "anomaly-analysis", "staleness-analysis", "orphan-analysis", "salience-analysis", "schema-synchronization", "meeting-preparation", "reminders", "reports", "dream-maintenance", "skill-evaluation", "projection-repair",
] as const;
export type ParityJobType = (typeof PARITY_JOB_TYPES)[number];

type Store = BrainStore;

export interface JobHandlerContext {
	store: Store;
	workerId: string;
	tenantId?: string;
	authority?: "read" | "write" | "admin";
	privacy?: JobPrivacy;
	embeddingProvider?: EmbeddingProvider;
	transcriptionProvider?: TranscriptionProvider;
	structuredExtractionProvider?: StructuredExtractionProvider;
	ocrProvider?: { recognize(image: Uint8Array, mimeType: string): Promise<string> };
	executors?: Partial<Record<ParityJobType, (job: BrainJob) => Promise<Record<string, unknown> | void>>>;
	onExecute?: (type: ParityJobType, job: BrainJob) => Promise<Record<string, unknown> | void>;
}

export interface JobExecutionPolicy extends JobBudget {
	dryRun?: boolean;
	actor?: string;
	ownedPaths?: string[];
	managedSections?: string[];
	rollbackRef?: string;
}

export interface JobRunReceipt {
	jobId: string;
	type: ParityJobType;
	status: "complete" | "duplicate" | "failed";
	resultHash: string;
	degraded?: boolean;
}

function canonicalParityJobType(value: string): ParityJobType | undefined {
		if (value === "index") return "indexing";
		if (value === "projection") return "projection-repair";
		return isParityJobType(value) ? value : undefined;
}
function isParityJobType(value: string): value is ParityJobType { return (PARITY_JOB_TYPES as readonly string[]).includes(value); }
function payloadObject(job: BrainJob): Record<string, unknown> { if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) throw new Error("job payload must be an object"); return job.payload as Record<string, unknown>; }
function idempotencyKey(job: BrainJob): string { const payload = payloadObject(job); const value = job.idempotencyKey ?? payload.idempotencyKey; return typeof value === "string" && value.trim() ? value : createHash("sha256").update(JSON.stringify({ tenantId: job.tenantId, type: job.type, payload })).digest("hex"); }

const mutationJobTypes = new Set<ParityJobType>(["indexing", "embedding", "extraction", "transcription", "source-synchronization", "entity-enrichment", "fact-extraction", "deduplication", "consolidation", "citation-repair", "backlink-reconciliation", "schema-synchronization", "meeting-preparation", "reminders", "dream-maintenance", "projection-repair"]);

function executionPolicy(context: JobHandlerContext, payload: Record<string, unknown>, type: ParityJobType): JobExecutionPolicy | undefined {
	if (payload.policy === undefined) return undefined;
	if (!payload.policy || typeof payload.policy !== "object" || Array.isArray(payload.policy)) throw new Error("job policy must be an object");
	const value = payload.policy as Record<string, unknown>;
	const privacy = value.privacy;
	const policy: JobExecutionPolicy = {
		privacy: privacy as JobPrivacy,
		...(typeof value.maxCost === "number" ? { maxCost: value.maxCost } : {}),
		...(typeof value.maxDurationMs === "number" ? { maxDurationMs: value.maxDurationMs } : {}),
		...(typeof value.requiredAuthority === "string" ? { requiredAuthority: value.requiredAuthority as JobExecutionPolicy["requiredAuthority"] } : {}),
		...(value.quietHours && typeof value.quietHours === "object" && !Array.isArray(value.quietHours) ? { quietHours: value.quietHours as JobExecutionPolicy["quietHours"] } : {}),
		...(typeof value.dryRun === "boolean" ? { dryRun: value.dryRun } : {}),
		...(typeof value.actor === "string" ? { actor: value.actor } : {}),
		...(Array.isArray(value.ownedPaths) ? { ownedPaths: value.ownedPaths as string[] } : {}),
		...(Array.isArray(value.managedSections) ? { managedSections: value.managedSections as string[] } : {}),
		...(typeof value.rollbackRef === "string" ? { rollbackRef: value.rollbackRef } : {}),
	};
	assertJobBudget(policy, { cost: typeof payload.cost === "number" ? payload.cost : 0, durationMs: typeof payload.durationMs === "number" ? payload.durationMs : 0, authority: context.authority ?? "admin", privacy: context.privacy ?? "local" });
	if (policy.actor !== undefined && (!policy.actor.trim() || policy.actor.length > 128 || /[\r\n\0]/u.test(policy.actor))) throw new Error("job actor is invalid");
	for (const paths of [policy.ownedPaths, policy.managedSections]) if (paths?.some((path) => typeof path !== "string" || !path.trim() || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\"))) throw new Error("job owned paths are invalid");
	if (!policy.dryRun && mutationJobTypes.has(type) && (!policy.actor || !policy.rollbackRef?.trim())) throw new Error("mutating job policy requires an actor and rollback reference");
	return policy;
}

function extractionList(context: JobHandlerContext): Array<PlainTextExtractor | ImageOcrExtractor | AudioTranscriptionExtractor | PdfExtractor | OfficeDocumentExtractor | ArchiveMetadataExtractor | BinaryMetadataExtractor> {
	return [
		new ImageOcrExtractor(context.ocrProvider),
		new AudioTranscriptionExtractor(context.transcriptionProvider),
		new PlainTextExtractor(),
		new PdfExtractor(),
		new OfficeDocumentExtractor(),
		new ArchiveMetadataExtractor(),
		new BinaryMetadataExtractor(),
	];
}

function scopedBrainId(payload: Record<string, unknown>): string {
	return typeof payload.brainId === "string" && payload.brainId.trim() ? payload.brainId : "local";
}

function schemaSelection(payload: Record<string, unknown>): { id: string; version: string } | undefined {
	if (payload.schemaPack === undefined) return undefined;
	if (!payload.schemaPack || typeof payload.schemaPack !== "object" || Array.isArray(payload.schemaPack)) throw new Error("job schema pack is invalid");
	const value = payload.schemaPack as Record<string, unknown>;
	if (typeof value.id !== "string" || !value.id.trim() || typeof value.version !== "string" || !value.version.trim()) throw new Error("job schema pack is invalid");
	return { id: value.id, version: value.version };
}

function maximumItems(payload: Record<string, unknown>, key = "maximumItems", fallback = 128): number {
	const value = payload[key] ?? fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000) throw new Error(`${key} must be an integer between 1 and 1000`);
	return value;
}

function stringList(value: unknown, label: string, maximum = 128): string[] {
	if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} must be a bounded list of strings`);
	return value.map((item) => (item as string).trim());
}

function scopedQuery(context: JobHandlerContext, job: BrainJob, payload: Record<string, unknown>): [string, string] {
	return [job.tenantId, scopedBrainId(payload)];
}

function deterministicId(job: BrainJob, kind: string, index: number): string {
	return createHash("sha256").update(`${job.tenantId}\0${job.id}\0${kind}\0${index}`).digest("hex");
}

async function structuredPayload(context: JobHandlerContext, payload: Record<string, unknown>, field: string): Promise<unknown> {
	if (payload[field] !== undefined) return payload[field];
	if (!context.structuredExtractionProvider || typeof payload.text !== "string" || !payload.text.trim()) return undefined;
	const schema = payload.schema && typeof payload.schema === "object" && !Array.isArray(payload.schema) ? payload.schema : { type: "object" };
	return context.structuredExtractionProvider.extract(payload.text, schema);
}

function normalizedFacts(value: unknown): Array<{ subject: string; predicate: string; objectValue: string; confidence: number; documentId?: string; chunkId?: string; metadata?: Record<string, unknown> }> {
	if (!Array.isArray(value) || value.length > 128) throw new Error("fact extraction requires a bounded facts list");
	return value.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("fact extraction returned an invalid fact");
		const fact = item as Record<string, unknown>;
		const confidence = fact.confidence === undefined ? 1 : fact.confidence;
		if (typeof fact.subject !== "string" || !fact.subject.trim() || typeof fact.predicate !== "string" || !fact.predicate.trim() || typeof fact.objectValue !== "string" || !fact.objectValue.trim() || typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("fact extraction returned an invalid fact");
		return { subject: fact.subject.trim(), predicate: fact.predicate.trim(), objectValue: fact.objectValue.trim(), confidence, ...(typeof fact.documentId === "string" ? { documentId: fact.documentId } : {}), ...(typeof fact.chunkId === "string" ? { chunkId: fact.chunkId } : {}), ...(fact.metadata && typeof fact.metadata === "object" && !Array.isArray(fact.metadata) ? { metadata: fact.metadata as Record<string, unknown> } : {}) };
	});
}

async function executeBuiltIn(context: JobHandlerContext, type: ParityJobType, job: BrainJob): Promise<Record<string, unknown> | undefined> {
	const payload = payloadObject(job);
	if (type === "embedding") {
		if (!context.embeddingProvider) throw new Error("embedding job requires an embedding provider");
		const scope = { tenantId: job.tenantId, brainId: typeof payload.brainId === "string" ? payload.brainId : "local" };
		return { embedding: await indexLocalEmbeddings(context.store, context.embeddingProvider, typeof payload.batchSize === "number" ? payload.batchSize : 32, scope) };
	}
	if (type === "transcription") {
		if (!context.transcriptionProvider || typeof payload.path !== "string" || !payload.path.trim()) throw new Error("transcription job requires a provider and path");
		const extracted = await extractLocalFile(payload.path, [new AudioTranscriptionExtractor(context.transcriptionProvider)], typeof payload.maximumBytes === "number" ? payload.maximumBytes : undefined);
		return { path: payload.path, contentHash: extracted.contentHash, metadata: extracted.metadata ?? {} };
	}
	if (type === "source-synchronization") {
		if (typeof payload.repositoryRoot !== "string" || !payload.repositoryRoot.trim() || typeof payload.sourceId !== "string" || !payload.sourceId.trim() || !Array.isArray(payload.documents)) throw new Error("source synchronization requires repositoryRoot, sourceId, and documents");
		const documents = payload.documents as NormalizedDocument[];
		const descriptor = payload.descriptor && typeof payload.descriptor === "object" && !Array.isArray(payload.descriptor) ? payload.descriptor as SourceDescriptor : { id: payload.sourceId, version: "1.0.0", kind: "job", trusted: true };
		const brainId = typeof payload.brainId === "string" && payload.brainId.trim() ? payload.brainId : "local";
		const schemaPack = payload.schemaPack && typeof payload.schemaPack === "object" && !Array.isArray(payload.schemaPack) ? payload.schemaPack as { id: string; version: string } : undefined;
		const lifecycle = createPgliteIngestionRunLifecycle(context.store, job.tenantId, brainId, schemaPack, payload.repositoryRoot);
		const result = await syncSource({ id: payload.sourceId, describe: () => descriptor, list: async () => documents }, new BrainRepository(payload.repositoryRoot), undefined, createAuditQuarantineSink(context.store, job.tenantId), lifecycle);
		return { sourceSynchronization: result, sourceId: payload.sourceId, brainId };
	}
	if (type === "reports") return { report: runAdvancedEvaluation() };
	if (type === "trajectories") {
		if (typeof payload.id !== "string" || !Array.isArray(payload.events)) throw new Error("trajectory job requires id and events");
		return { trajectory: buildTrajectory(payload.id, payload.events as never, typeof payload.maximumEvents === "number" ? payload.maximumEvents : undefined) };
	}
	if (type === "schema-synchronization") {
		if (!payload.pack || typeof payload.pack !== "object" || Array.isArray(payload.pack)) throw new Error("schema synchronization requires a schema pack");
		const pack = assertSchemaPack(payload.pack as never);
		return { schemaPack: { id: pack.id, version: pack.version }, pathTypes: Object.keys(pack.pathTypes).length };
	}
	if (type === "extraction") {
		if (typeof payload.path !== "string" || !payload.path.trim()) throw new Error("extraction job requires a path");
		const schemaPack = payload.schemaPack && typeof payload.schemaPack === "object" && !Array.isArray(payload.schemaPack) ? payload.schemaPack as { id: string; version: string } : undefined;
		const extracted = await extractLocalFile(payload.path, extractionList(context), typeof payload.maximumBytes === "number" ? payload.maximumBytes : undefined, undefined, schemaPack);
		return { path: payload.path, contentHash: extracted.contentHash, metadata: extracted.metadata ?? {} };
	}
	if (type === "anomaly-analysis") {
		if (!Array.isArray(payload.records)) throw new Error("anomaly analysis requires records");
		const records = payload.records as Array<{ tenantId: string; brainId: string }>;
		if (records.some((record) => record.tenantId !== job.tenantId)) throw new Error("anomaly records cross tenant scope");
		return { anomalies: detectAnomalies(records as never) };
	}
	if (type === "entity-enrichment") {
		const extracted = await structuredPayload(context, payload, "entities");
		const value = extracted && typeof extracted === "object" && !Array.isArray(extracted) && Array.isArray((extracted as Record<string, unknown>).entities) ? (extracted as Record<string, unknown>).entities : extracted;
		if (value === undefined) return { entities: [], persisted: 0 };
		if (!Array.isArray(value) || value.length > 128) throw new Error("entity enrichment requires a bounded entities list");
		const brainId = scopedBrainId(payload);
		const selectedSchemaPack = schemaSelection(payload);
		const persisted: string[] = [];
		for (const [index, item] of value.entries()) {
			if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("entity enrichment returned an invalid entity");
			const entity = item as Record<string, unknown>;
			const externalId = typeof entity.externalId === "string" ? entity.externalId.trim() : "";
			const label = typeof entity.label === "string" ? entity.label.trim() : externalId;
			const nodeType = typeof entity.type === "string" && entity.type.trim() ? entity.type.trim() : "entity";
			if (!externalId || !label || !nodeType || externalId.length > 512 || label.length > 2_000) throw new Error("entity enrichment returned an invalid entity");
			const id = deterministicId(job, "entity", index);
			await context.store.query("INSERT INTO brain_graph_nodes (id, tenant_id, brain_id, node_type, external_id, label, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, metadata = EXCLUDED.metadata", [id, job.tenantId, brainId, nodeType, externalId, label, JSON.stringify({ ...(entity.metadata && typeof entity.metadata === "object" && !Array.isArray(entity.metadata) ? entity.metadata : {}), ...(selectedSchemaPack ? { schemaPack: selectedSchemaPack } : {}) })]);
			persisted.push(id);
		}
		return { entities: persisted, persisted: persisted.length, brainId };
	}
	if (type === "fact-extraction") {
		const extracted = await structuredPayload(context, payload, "facts");
		const value = extracted && typeof extracted === "object" && !Array.isArray(extracted) && Array.isArray((extracted as Record<string, unknown>).facts) ? (extracted as Record<string, unknown>).facts : extracted;
		const facts = normalizedFacts(value ?? []);
		const brainId = scopedBrainId(payload);
		const selectedSchemaPack = schemaSelection(payload);
		const persisted: string[] = [];
		for (const [index, fact] of facts.entries()) {
			const id = deterministicId(job, "fact", index);
			await context.store.query("INSERT INTO brain_facts (id, tenant_id, brain_id, subject, predicate, object_value, document_id, chunk_id, confidence, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) ON CONFLICT (id) DO NOTHING", [id, job.tenantId, brainId, fact.subject, fact.predicate, fact.objectValue, fact.documentId ?? null, fact.chunkId ?? null, fact.confidence, JSON.stringify({ ...(fact.metadata ?? {}), jobId: job.id, ...(selectedSchemaPack ? { schemaPack: selectedSchemaPack } : {}) })]);
			persisted.push(id);
		}
		return { facts: persisted, persisted: persisted.length, brainId };
	}
	if (type === "deduplication") {
		const [tenantId, brainId] = scopedQuery(context, job, payload);
		const limit = maximumItems(payload);
		const duplicates = await context.store.query("SELECT content_hash, array_agg(id ORDER BY id) AS document_ids, count(*)::int AS count FROM brain_documents WHERE tenant_id = $1 AND brain_id = $2 AND deleted_at IS NULL GROUP BY content_hash HAVING count(*) > 1 ORDER BY content_hash LIMIT $3", [tenantId, brainId, limit]);
		return { proposals: duplicates.map((duplicate) => ({ ...duplicate, requiresApproval: true })), examined: duplicates.length, brainId };
	}
	if (type === "consolidation") {
		const [tenantId, brainId] = scopedQuery(context, job, payload);
		const limit = maximumItems(payload);
		const groups = await context.store.query("SELECT subject, predicate, array_agg(id ORDER BY id) AS fact_ids, count(*)::int AS count FROM brain_facts WHERE tenant_id = $1 AND brain_id = $2 GROUP BY subject, predicate HAVING count(*) > 1 ORDER BY subject, predicate LIMIT $3", [tenantId, brainId, limit]);
		return { proposals: groups.map((group) => ({ ...group, requiresApproval: true })), examined: groups.length, brainId };
	}
	if (type === "citation-repair") {
		const citations = payload.citations === undefined ? [] : payload.citations;
		if (!Array.isArray(citations) || citations.length > 128) throw new Error("citation repair requires a bounded citations list");
		const [tenantId, brainId] = scopedQuery(context, job, payload);
		const valid: unknown[] = [];
		const unresolved: unknown[] = [];
		for (const citation of citations) {
			const value = typeof citation === "string" ? { id: citation.trim(), ...(citation.includes(":") ? { chunkId: citation.split(":").at(-1) } : { documentId: citation.trim() }) } : citation;
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("citation repair returned an invalid citation");
			const item = value as Record<string, unknown>;
			const documentId = typeof item.documentId === "string" ? item.documentId : undefined;
			const chunkId = typeof item.chunkId === "string" ? item.chunkId : undefined;
			if (!documentId && !chunkId) throw new Error("citation repair requires a documentId or chunkId");
			const rows = chunkId ? await context.store.query("SELECT c.id, c.document_id FROM brain_chunks c JOIN brain_documents d ON d.id = c.document_id WHERE c.id = $1 AND d.tenant_id = $2 AND d.brain_id = $3 AND d.deleted_at IS NULL", [chunkId, tenantId, brainId]) : await context.store.query("SELECT id FROM brain_documents WHERE id = $1 AND tenant_id = $2 AND brain_id = $3 AND deleted_at IS NULL", [documentId!, tenantId, brainId]);
			(rows.length ? valid : unresolved).push({ ...item, ...(rows[0] ?? {}) });
		}
		return { valid, unresolved, repaired: 0, requiresApproval: true, brainId };
	}
	if (type === "backlink-reconciliation") {
		const [tenantId, brainId] = scopedQuery(context, job, payload);
		const limit = maximumItems(payload);
		const broken = await context.store.query("SELECT l.source_document_id, source.path AS source_path, l.target_path FROM brain_links l JOIN brain_documents source ON source.id = l.source_document_id AND source.tenant_id = l.tenant_id AND source.brain_id = l.brain_id LEFT JOIN brain_documents target ON target.tenant_id = l.tenant_id AND target.brain_id = l.brain_id AND target.path = l.target_path AND target.deleted_at IS NULL WHERE l.tenant_id = $1 AND l.brain_id = $2 AND source.deleted_at IS NULL AND target.id IS NULL ORDER BY source.path, l.target_path LIMIT $3", [tenantId, brainId, limit]);
		return { repairs: broken.map((link) => ({ ...link, requiresApproval: true })), examined: broken.length, brainId };
	}
	if (type === "contradiction-analysis") {
		const [tenantId, brainId] = scopedQuery(context, job, payload);
		const limit = maximumItems(payload);
		const contradictions = await context.store.query("SELECT subject, predicate, array_agg(DISTINCT object_value ORDER BY object_value) AS object_values, count(DISTINCT object_value)::int AS values FROM brain_facts WHERE tenant_id = $1 AND brain_id = $2 GROUP BY subject, predicate HAVING count(DISTINCT object_value) > 1 ORDER BY subject, predicate LIMIT $3", [tenantId, brainId, limit]);
		return { contradictions, examined: contradictions.length, brainId };
	}
	if (type === "staleness-analysis") {
		const [tenantId, brainId] = scopedQuery(context, job, payload);
		const limit = maximumItems(payload);
		const stale = await context.store.query("SELECT id, path, stale, source_updated_at, indexed_at FROM brain_documents WHERE tenant_id = $1 AND brain_id = $2 AND deleted_at IS NULL AND (stale = true OR source_updated_at IS NOT NULL AND source_updated_at < indexed_at) ORDER BY indexed_at ASC, path LIMIT $3", [tenantId, brainId, limit]);
		return { stale, examined: stale.length, brainId };
	}
	if (type === "orphan-analysis") {
		const [tenantId, brainId] = scopedQuery(context, job, payload);
		const limit = maximumItems(payload);
		const orphans = await context.store.query("SELECT d.id, d.path FROM brain_documents d WHERE d.tenant_id = $1 AND d.brain_id = $2 AND d.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM brain_links l WHERE l.tenant_id = d.tenant_id AND l.brain_id = d.brain_id AND l.source_document_id = d.id) AND NOT EXISTS (SELECT 1 FROM brain_links l JOIN brain_documents source ON source.id = l.source_document_id WHERE l.tenant_id = d.tenant_id AND l.brain_id = d.brain_id AND l.target_path = d.path AND source.deleted_at IS NULL) ORDER BY d.path LIMIT $3", [tenantId, brainId, limit]);
		return { orphans, examined: orphans.length, brainId };
	}
	if (type === "salience-analysis") {
		const [tenantId, brainId] = scopedQuery(context, job, payload);
		const limit = maximumItems(payload);
		const salient = await context.store.query("SELECT d.id, d.path, count(DISTINCT c.id)::int AS chunk_count, count(DISTINCT l.target_path)::int AS outbound_links FROM brain_documents d LEFT JOIN brain_chunks c ON c.document_id = d.id LEFT JOIN brain_links l ON l.source_document_id = d.id AND l.tenant_id = d.tenant_id AND l.brain_id = d.brain_id WHERE d.tenant_id = $1 AND d.brain_id = $2 AND d.deleted_at IS NULL GROUP BY d.id, d.path ORDER BY (count(DISTINCT c.id) + count(DISTINCT l.target_path)) DESC, d.path LIMIT $3", [tenantId, brainId, limit]);
		return { salient, examined: salient.length, brainId };
	}
	if (type === "meeting-preparation") {
		if (typeof payload.meetingId !== "string" || !payload.meetingId.trim() || typeof payload.title !== "string" || !payload.title.trim()) throw new Error("meeting preparation requires meetingId and title");
		const participants = payload.participants === undefined ? [] : stringList(payload.participants, "meeting participants", 64);
		const agenda = payload.agenda === undefined ? [] : stringList(payload.agenda, "meeting agenda", 64);
		return { meeting: { id: payload.meetingId, title: payload.title.trim(), participants, agenda }, prepared: true, requiresApproval: true };
	}
	if (type === "reminders") {
		if (!Array.isArray(payload.reminders) || payload.reminders.length > 128) throw new Error("reminders requires a bounded reminders list");
		const reminders = payload.reminders.map((item) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("reminders returned an invalid reminder");
			const reminder = item as Record<string, unknown>;
			if (typeof reminder.id !== "string" || !reminder.id.trim() || typeof reminder.text !== "string" || !reminder.text.trim() || typeof reminder.dueAt !== "string" || Number.isNaN(Date.parse(reminder.dueAt))) throw new Error("reminders returned an invalid reminder");
			return { id: reminder.id.trim(), text: reminder.text.trim(), dueAt: new Date(reminder.dueAt).toISOString() };
		}).sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt) || left.id.localeCompare(right.id));
		return { reminders, scheduled: reminders.length };
	}
	if (type === "dream-maintenance") {
		if (typeof payload.brainId !== "string" || !Array.isArray(payload.findings) || payload.findings.some((finding) => typeof finding !== "string")) throw new Error("dream maintenance requires brainId and findings");
		return { proposal: proposeSelfMaintenance({ tenantId: job.tenantId, brainId: payload.brainId, findings: payload.findings as string[], dryRun: true }) };
	}
	if (type === "skill-evaluation") return { skills: createPinnedSkillRegistry().list().map((skill) => ({ id: skill.id, version: skill.version, agents: skill.agents })) };
	return undefined;
}

export class DurableJobHandlerRegistry {
	private readonly completed = new IdempotencyLedger();
	constructor(private readonly context: JobHandlerContext) {}

	list(): ParityJobType[] { return [...PARITY_JOB_TYPES]; }

	async execute(job: BrainJob): Promise<JobRunReceipt> {
		const type = canonicalParityJobType(job.type);
		if (!type) throw new Error(`unsupported parity job type: ${job.type}`);
		const key = idempotencyKey(job);
		const cached = this.completed.get<JobRunReceipt>(key);
		if (cached) return { ...cached, status: "duplicate" };
		const persisted = await this.context.store.query<{ metadata: unknown }>("SELECT metadata FROM brain_job_events WHERE tenant_id = $1 AND job_id = $2 AND event_type = 'complete' ORDER BY created_at DESC LIMIT 1", [job.tenantId, job.id]);
		const metadata = persisted[0]?.metadata;
		const persistedMetadata = typeof metadata === "string" ? JSON.parse(metadata) as Record<string, unknown> : metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : undefined;
		if (persistedMetadata && typeof persistedMetadata.resultHash === "string") {
			const receipt: JobRunReceipt = { jobId: job.id, type, status: "duplicate", resultHash: persistedMetadata.resultHash, ...(persistedMetadata.degraded === true ? { degraded: true } : {}) };
			this.completed.record(key, { ...receipt, status: "complete" });
			return receipt;
		}
		const policy = executionPolicy(this.context, payloadObject(job), type);
		const effectivePolicy: JobExecutionPolicy = policy ?? { privacy: this.context.privacy ?? "local", requiredAuthority: mutationJobTypes.has(type) ? "write" : "read", actor: this.context.workerId, rollbackRef: `job:${job.id}` };
		if (!policy) assertJobBudget(effectivePolicy, { cost: typeof payloadObject(job).cost === "number" ? payloadObject(job).cost as number : 0, durationMs: typeof payloadObject(job).durationMs === "number" ? payloadObject(job).durationMs as number : 0, authority: this.context.authority ?? "admin", privacy: this.context.privacy ?? "local" });
		const policyMetadata = { privacy: effectivePolicy.privacy, requiredAuthority: effectivePolicy.requiredAuthority ?? "read", actor: effectivePolicy.actor ?? this.context.workerId, rollbackRef: effectivePolicy.rollbackRef ?? `job:${job.id}`, ...(effectivePolicy.maxCost !== undefined ? { maxCost: effectivePolicy.maxCost } : {}), ...(effectivePolicy.maxDurationMs !== undefined ? { maxDurationMs: effectivePolicy.maxDurationMs } : {}), ...(effectivePolicy.quietHours ? { quietHours: effectivePolicy.quietHours } : {}), ...(effectivePolicy.ownedPaths ? { ownedPaths: effectivePolicy.ownedPaths } : {}), ...(effectivePolicy.managedSections ? { managedSections: effectivePolicy.managedSections } : {}) };
		await updateJobProgress(this.context.store, job.id, this.context.workerId, { phase: "started", type, percent: 0 }, job.tenantId);
		await recordJobEvent(this.context.store, { jobId: job.id, tenantId: job.tenantId, eventType: "started", metadata: { type, idempotencyKey: key, ...policyMetadata } });
		const executableJob = { ...job, type, idempotencyKey: key };
		const executionStartedAt = Date.now();
		let result: Record<string, unknown> | void;
		if (effectivePolicy.dryRun) result = { type, dryRun: true, planned: true, actor: policyMetadata.actor, rollbackRef: policyMetadata.rollbackRef };
		else if (type === "indexing" || type === "projection-repair") {
			const payload = payloadObject(executableJob);
			if (typeof payload.repositoryRoot !== "string" || !payload.repositoryRoot.trim()) throw new Error(`${type} job requires repositoryRoot`);
			result = await indexBrainRepository(this.context.store, new BrainRepository(payload.repositoryRoot)) as unknown as Record<string, unknown>;
		} else if (this.context.executors?.[type]) result = await this.context.executors[type]!(executableJob);
		else if (this.context.onExecute) result = await this.context.onExecute(type, executableJob);
		else {
			result = await executeBuiltIn(this.context, type, executableJob);
			if (!result) throw new Error(`no durable implementation registered for parity job type: ${type}`);
		}
		if (!result) throw new Error(`parity job handler ${type} must return a durable result`);
		const output = result;
		assertJobBudget(effectivePolicy, { cost: typeof output.cost === "number" ? output.cost : typeof payloadObject(job).cost === "number" ? payloadObject(job).cost as number : 0, durationMs: Date.now() - executionStartedAt, authority: this.context.authority ?? "admin", privacy: this.context.privacy ?? "local" });
		const receipt: JobRunReceipt = { jobId: job.id, type, status: "complete", resultHash: createHash("sha256").update(JSON.stringify(output)).digest("hex") };
		await updateJobProgress(this.context.store, job.id, this.context.workerId, { phase: "complete", type, percent: 100, resultHash: receipt.resultHash }, job.tenantId);
		await recordJobEvent(this.context.store, { jobId: job.id, tenantId: job.tenantId, eventType: "complete", metadata: { type, resultHash: receipt.resultHash, degraded: receipt.degraded ?? false, dryRun: effectivePolicy.dryRun ?? false, ...(job.degradedInput ? { degradedInput: true } : {}), ...policyMetadata } });
		await this.context.store.query("INSERT INTO brain_rollback_receipts (id, tenant_id, brain_id, run_id, target_kind, target_id, rollback_ref, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) ON CONFLICT (id) DO NOTHING", [deterministicId(job, "rollback", 0), job.tenantId, scopedBrainId(payloadObject(job)), job.id, "job", job.id, policyMetadata.rollbackRef, JSON.stringify({ type, resultHash: receipt.resultHash, dryRun: effectivePolicy.dryRun ?? false, actor: policyMetadata.actor })]);
		await recordAuditEvent(this.context.store, { tenantId: job.tenantId, action: effectivePolicy.dryRun ? "job.dry_run" : "job.completed", subjectId: job.id, metadata: { type, resultHash: receipt.resultHash, ...policyMetadata } });
		return this.completed.record(key, receipt);
	}

	async run(job: BrainJob): Promise<JobRunReceipt> {
		try { return await this.execute(job); }
		catch (error) { const decision = classifyJobFailure(error); const reason = decision.reason.slice(0, 512); await recordJobEvent(this.context.store, { jobId: job.id, tenantId: job.tenantId, eventType: "failed", metadata: { retryable: decision.retryable, reason } }); await recordAuditEvent(this.context.store, { tenantId: job.tenantId, action: "job.failed", subjectId: job.id, metadata: { type: job.type, retryable: decision.retryable, reason, actor: this.context.workerId, rollbackRef: `job:${job.id}` } }); throw error; }
	}
}

export function createParityJobHandlers(context: JobHandlerContext): Record<string, (job: BrainJob) => Promise<void>> {
	const registry = new DurableJobHandlerRegistry(context);
	return Object.fromEntries(PARITY_JOB_TYPES.map((type) => [type, async (job: BrainJob) => { await registry.run({ ...job, type }); }])) as Record<string, (job: BrainJob) => Promise<void>>;
}
