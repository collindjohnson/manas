import { createHash, randomUUID } from "node:crypto";
import type { NormalizedDocument, SourceAdapter, SourceCheckpoint } from "./types";

const managedStart = "<!-- brain:managed:start -->";
const managedEnd = "<!-- brain:managed:end -->";
const conformanceModule = await import([".", "conformance"].join(String.fromCharCode(47)));

type SourceRecord = { type: string; externalId: string; provenance?: NormalizedDocument["provenance"]; externalRevision?: string; contentHash?: string; extractionMetadata?: Record<string, string>; updatedAt?: string; visibilityLabels?: string[]; managedSections?: string[] };
export interface SourceCheckpointStore {
	get(sourceId: string): Promise<SourceCheckpoint | undefined>;
	set(sourceId: string, checkpoint: SourceCheckpoint): Promise<void>;
}
export interface SourceQuarantineSink {
	record(event: { sourceId: string; reason: string; documentCount: number; occurredAt: string }): Promise<void>;
}

export interface IngestionRunLifecycle {
	begin(input: { sourceId: string; checkpoint?: SourceCheckpoint }): Promise<string>;
	complete(runId: string, checkpoint?: SourceCheckpoint): Promise<void>;
	fail(runId: string, status: "failed" | "quarantined", checkpoint?: SourceCheckpoint, reason?: string, metadata?: Record<string, unknown>): Promise<void>;
	scheduleProjection?(runId: string): Promise<void>;
}

export function createPgliteIngestionRunLifecycle(store: { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]> }, tenantId = "local", brainId = "local", schemaPack?: { id: string; version: string }, repositoryRoot?: string): IngestionRunLifecycle {
	if (!tenantId.trim() || !brainId.trim()) throw new Error("ingestion lifecycle scope is required");
	if (schemaPack && (!schemaPack.id.trim() || !schemaPack.version.trim())) throw new Error("ingestion schema pack is invalid");
	return {
		begin: async (input) => {
			if (!input.sourceId.trim()) throw new Error("ingestion source is required");
			const rows = await store.query<{ id: string }>("INSERT INTO brain_ingestion_runs (id, tenant_id, brain_id, source_id, status, checkpoint) VALUES ($1, $2, $3, $4, 'running', $5::jsonb) RETURNING id", [randomUUID(), tenantId, brainId, input.sourceId, input.checkpoint ? JSON.stringify(input.checkpoint) : null]);
			if (!rows[0]?.id) throw new Error("ingestion run was not created");
			return rows[0].id;
		},
		complete: async (runId, checkpoint) => {
			const rows = await store.query<{ id: string }>("UPDATE brain_ingestion_runs SET status = 'complete', checkpoint = $2::jsonb, completed_at = now() WHERE id = $1 AND tenant_id = $3 AND status = 'running' RETURNING id", [runId, checkpoint ? JSON.stringify(checkpoint) : null, tenantId]);
			if (!rows.length) throw new Error("ingestion run is not active");
		},
		fail: async (runId, status, checkpoint, reason = "source ingestion failed", metadata = {}) => {
			const rows = await store.query<{ id: string }>("UPDATE brain_ingestion_runs SET status = $2, checkpoint = $3::jsonb, completed_at = now() WHERE id = $1 AND tenant_id = $4 AND status = 'running' RETURNING id", [runId, status, checkpoint ? JSON.stringify(checkpoint) : null, tenantId]);
			if (!rows.length) throw new Error("ingestion run is not active");
			await store.query("INSERT INTO brain_source_failures (id, tenant_id, brain_id, source_id, ingestion_run_id, status, reason, metadata) SELECT $1, $2, $3, source_id, $4, $5, $6, $7::jsonb FROM brain_ingestion_runs WHERE id = $4 AND tenant_id = $2", [randomUUID(), tenantId, brainId, runId, status, reason, JSON.stringify(metadata)]);
		},
		scheduleProjection: async (runId) => {
			const idempotencyKey = `projection:${tenantId}:${runId}`;
			const payload = { ingestionRunId: runId, brainId, ...(repositoryRoot ? { repositoryRoot } : {}), ...(schemaPack ? { schemaPack } : {}) };
			const rows = await store.query<{ id: string }>("INSERT INTO brain_jobs (id, tenant_id, type, payload, status, available_at, idempotency_key) VALUES ($1, $2, 'projection', $3::jsonb, 'pending', now(), $4::text) ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id", [randomUUID(), tenantId, JSON.stringify(payload), idempotencyKey]);
			if (rows[0]?.id) return;
			const existing = await store.query<{ id: string }>("SELECT id FROM brain_jobs WHERE tenant_id = $1 AND idempotency_key = $2", [tenantId, idempotencyKey]);
			if (!existing[0]?.id) throw new Error("projection job was not scheduled");
		},
	};
}

export function createAuditQuarantineSink(store: { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]> }, tenantId = "local"): SourceQuarantineSink {
	return { record: async (event) => {
		const auditModule = await import(["..", "brain", "audit"].join(String.fromCharCode(47)));
		await auditModule.recordAuditEvent(store, { tenantId, action: "source.quarantined", subjectId: event.sourceId, metadata: { reason: event.reason, documentCount: event.documentCount, occurredAt: event.occurredAt } });
	} };
}

type Repository = {
	listPages(includeDeleted?: boolean): Promise<Array<{ path: string; revision: string; source?: SourceRecord }>>;
	getPage(path: string): Promise<{ content: string } | undefined>;
	putPage(path: string, content: string, expectedRevision?: string, source?: SourceRecord): Promise<unknown>;
	movePage?(from: string, to: string, expectedRevision: string): Promise<unknown>;
	markStaleBySource(type: string, externalId: string): Promise<number>;
	registerSourceDescriptor?(descriptor: { id: string; version: string; kind: string; trusted: boolean }): Promise<unknown>;
};

export function renderManagedDocument(sourceContent: string, existing?: string): string {
	const managed = `${managedStart}\n${sourceContent.trimEnd()}\n${managedEnd}`;
	if (!existing) return `${managed}\n\n## Notes\n`;
	const start = existing.indexOf(managedStart);
	const end = existing.indexOf(managedEnd);
	if (start < 0 || end < start) return `${managed}\n\n${existing}`;
	return `${existing.slice(0, start)}${managed}${existing.slice(end + managedEnd.length)}`;
}

function sameSource(left: SourceRecord | undefined, right: SourceRecord): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export async function syncSource(adapter: SourceAdapter, repository: Repository, checkpoints?: SourceCheckpointStore, quarantine?: SourceQuarantineSink, lifecycle?: IngestionRunLifecycle): Promise<{ created: number; updated: number; stale: number; quarantined: number }> {
	if (!adapter.list && !adapter.scan) throw new Error("source adapter must provide list or scan");
	if (adapter.describe) {
		const descriptor = adapter.describe();
		conformanceModule.assertSourceDescriptor(descriptor);
		if (repository.registerSourceDescriptor) await repository.registerSourceDescriptor(descriptor);
	}
	let created = 0;
	let updated = 0;
	let stale = 0;
	const entries = await repository.listPages(true);
	const checkpoint = adapter.scan && checkpoints ? await checkpoints.get(adapter.id) : undefined;
	const runId = lifecycle ? await lifecycle.begin({ sourceId: adapter.id, checkpoint }) : undefined;
	let rawDocuments: NormalizedDocument[];
	try {
		rawDocuments = adapter.scan ? await Array.fromAsync(adapter.scan(checkpoint)) : await adapter.list!();
	} catch (error) {
		if (runId) await lifecycle?.fail(runId, "failed", checkpoint, error instanceof Error ? error.message : "source adapter failed");
		throw error;
	}
	const documents: NormalizedDocument[] = rawDocuments.map((document) => ({ ...document, contentHash: document.contentHash ?? createHash("sha256").update(document.content).digest("hex") }));
	try { conformanceModule.assertNormalizedDocuments(adapter.id, documents); }
	catch (error) {
		const reason = error instanceof Error ? error.message : "invalid source documents";
		await quarantine?.record({ sourceId: adapter.id, reason, documentCount: documents.length, occurredAt: new Date().toISOString() });
		if (runId) await lifecycle?.fail(runId, "quarantined", checkpoint, reason, { documentCount: documents.length });
		return { created: 0, updated: 0, stale: 0, quarantined: documents.length };
	}
	try {
	if (!adapter.scan) {
		const present = new Set(documents.map((document) => document.externalId));
		for (const entry of entries) {
			if (!entry.source || entry.source.type !== adapter.id || present.has(entry.source.externalId)) continue;
			stale += await repository.markStaleBySource(adapter.id, entry.source.externalId);
		}
	}
	for (const document of documents) {
		const existing = entries.find((entry) => entry.source?.type === adapter.id && entry.source.externalId === document.externalId);
		if (document.deleted) {
			stale += await repository.markStaleBySource(adapter.id, document.externalId);
			continue;
		}
		const source = { type: adapter.id, externalId: document.externalId, provenance: document.provenance, externalRevision: document.externalRevision, contentHash: document.contentHash, extractionMetadata: document.extractionMetadata, updatedAt: document.updatedAt, visibilityLabels: document.visibilityLabels, managedSections: document.managedSections };
		if (!existing) {
			await repository.putPage(document.suggestedPath, renderManagedDocument(document.content), undefined, source);
			created += 1;
			continue;
		}
		let currentPath = existing.path;
		let moved = false;
		if (repository.movePage && document.suggestedPath !== existing.path) {
			await repository.movePage(existing.path, document.suggestedPath, existing.revision);
			currentPath = document.suggestedPath;
			moved = true;
		}
		const current = await repository.getPage(currentPath);
		if (!current) throw new Error("source manifest page is unavailable");
		const content = renderManagedDocument(document.content, current.content);
		if (content === current.content && sameSource(existing.source, source)) {
			if (moved) updated += 1;
			continue;
		}
		await repository.putPage(currentPath, content, existing.revision, source);
		updated += 1;
	}
	const latest = documents.map((document) => document.updatedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
	const nextCheckpoint: SourceCheckpoint | undefined = adapter.checkpoint?.() ?? (latest ? { updatedAt: latest, ...(checkpoint?.cursor ? { cursor: checkpoint.cursor } : {}) } : checkpoint);
	if (runId) await lifecycle?.scheduleProjection?.(runId);
	if (adapter.scan && checkpoints) {
		if (nextCheckpoint) await checkpoints.set(adapter.id, nextCheckpoint);
	}
	if (runId) await lifecycle?.complete(runId, nextCheckpoint);
	return { created, updated, stale, quarantined: 0 };
	} catch (error) {
		if (runId) await lifecycle?.fail(runId, "failed", checkpoint, error instanceof Error ? error.message : "source synchronization failed");
		throw error;
	}
}
