import { createHash, randomUUID } from "node:crypto";

type Store = { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]> };

export interface AnalyticsScope { tenantId: string; brainId: string; }
export interface SchemaPackSelection { id: string; version: string; }
export interface EmbeddingCoverage { tenantId: string; brainId: string; modelFingerprint: string; totalChunks: number; coveredChunks: number; }
export interface ScopedCacheEntry { id: string; tenantId: string; brainId: string; cacheKey: string; projectedCommit: string; schemaVersion: string; schemaPack?: SchemaPackSelection; modelFingerprint: string; value: unknown; expiresAt?: string; }
export interface FactRecord { id: string; tenantId: string; brainId: string; subject: string; predicate: string; objectValue: string; documentId?: string; chunkId?: string; confidence: number; validFrom?: string; validTo?: string; schemaPack?: SchemaPackSelection; metadata: Record<string, unknown>; }
export interface ClaimRecord { id: string; tenantId: string; brainId: string; factId?: string; claim: string; status: "active" | "retracted" | "superseded"; confidence: number; documentId?: string; chunkId?: string; schemaPack?: SchemaPackSelection; metadata: Record<string, unknown>; }
export interface TimelineRecord { id: string; tenantId: string; brainId: string; subject: string; eventAt: string; label: string; schemaPack?: SchemaPackSelection; metadata: Record<string, unknown>; }

function scope(input: AnalyticsScope): void { if (!input.tenantId.trim() || !input.brainId.trim()) throw new Error("analytics scope is required"); }
function jsonValue<T>(value: unknown, fallback: T): T { if (typeof value === "string") { try { return JSON.parse(value) as T; } catch { return fallback; } } return value === undefined || value === null ? fallback : value as T; }
function schemaVersion(input: { schemaVersion?: string; schemaPack?: SchemaPackSelection }): string {
	if (input.schemaPack) {
		if (!input.schemaPack.id.trim() || !input.schemaPack.version.trim()) throw new Error("schema pack identity is required");
		return `${input.schemaPack.id}@${input.schemaPack.version}`;
	}
	if (!input.schemaVersion?.trim()) throw new Error("cache identity is required");
	return input.schemaVersion;
}
function withSchemaMetadata(metadata: Record<string, unknown> | undefined, selectedSchemaPack?: SchemaPackSelection): Record<string, unknown> {
	if (selectedSchemaPack && (!selectedSchemaPack.id.trim() || !selectedSchemaPack.version.trim())) throw new Error("schema pack identity is required");
	return { ...(metadata ?? {}), ...(selectedSchemaPack ? { schemaPack: selectedSchemaPack } : {}) };
}

export async function refreshEmbeddingCoverage(store: Store, input: AnalyticsScope & { modelFingerprint: string }): Promise<EmbeddingCoverage> {
	scope(input);
	if (!input.modelFingerprint.trim()) throw new Error("embedding model fingerprint is required");
	const rows = await store.query<{ total: number | string; covered: number | string }>("SELECT count(*)::int AS total, count(*) FILTER (WHERE c.embedding IS NOT NULL AND c.embedding_model = $3)::int AS covered FROM brain_chunks c JOIN brain_documents d ON d.id = c.document_id WHERE d.tenant_id = $1 AND d.brain_id = $2 AND d.deleted_at IS NULL", [input.tenantId, input.brainId, input.modelFingerprint]);
	const totalChunks = Number(rows[0]?.total ?? 0);
	const coveredChunks = Number(rows[0]?.covered ?? 0);
	await store.query("INSERT INTO brain_embedding_coverage (tenant_id, brain_id, model_fingerprint, total_chunks, covered_chunks) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, brain_id, model_fingerprint) DO UPDATE SET total_chunks = EXCLUDED.total_chunks, covered_chunks = EXCLUDED.covered_chunks, updated_at = now()", [input.tenantId, input.brainId, input.modelFingerprint, totalChunks, coveredChunks]);
	return { tenantId: input.tenantId, brainId: input.brainId, modelFingerprint: input.modelFingerprint, totalChunks, coveredChunks };
}

export async function setScopedCache(store: Store, input: Omit<ScopedCacheEntry, "id" | "schemaVersion"> & { id?: string; schemaVersion?: string }): Promise<ScopedCacheEntry> {
	scope(input);
	const selectedSchemaVersion = schemaVersion(input);
	if (![input.cacheKey, input.projectedCommit, input.modelFingerprint].every((value) => value.trim())) throw new Error("cache identity is required");
	const id = input.id ?? createHash("sha256").update([input.tenantId, input.brainId, input.cacheKey, input.projectedCommit, selectedSchemaVersion, input.modelFingerprint].join("\0")).digest("hex");
	const rows = await store.query<{ id: string; expires_at: string | null }>("INSERT INTO brain_cache_entries (id, tenant_id, brain_id, cache_key, projected_commit, schema_version, model_fingerprint, value, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) ON CONFLICT (tenant_id, brain_id, cache_key, projected_commit, schema_version, model_fingerprint) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at RETURNING id, expires_at", [id, input.tenantId, input.brainId, input.cacheKey, input.projectedCommit, selectedSchemaVersion, input.modelFingerprint, JSON.stringify(input.value), input.expiresAt ?? null]);
	return { ...input, id: rows[0]?.id ?? id, schemaVersion: selectedSchemaVersion, ...(rows[0]?.expires_at ? { expiresAt: new Date(rows[0].expires_at).toISOString() } : {}) };
}

export async function getScopedCache(store: Store, input: AnalyticsScope & { cacheKey: string; projectedCommit: string; schemaVersion?: string; schemaPack?: SchemaPackSelection; modelFingerprint: string }): Promise<ScopedCacheEntry | undefined> {
	scope(input);
	const selectedSchemaVersion = schemaVersion(input);
	const rows = await store.query<{ id: string; tenant_id: string; brain_id: string; cache_key: string; projected_commit: string; schema_version: string; model_fingerprint: string; value: unknown; expires_at: string | null }>("SELECT id, tenant_id, brain_id, cache_key, projected_commit, schema_version, model_fingerprint, value, expires_at FROM brain_cache_entries WHERE tenant_id = $1 AND brain_id = $2 AND cache_key = $3 AND projected_commit = $4 AND schema_version = $5 AND model_fingerprint = $6 AND (expires_at IS NULL OR expires_at > now())", [input.tenantId, input.brainId, input.cacheKey, input.projectedCommit, selectedSchemaVersion, input.modelFingerprint]);
	const row = rows[0];
	return row ? { id: row.id, tenantId: row.tenant_id, brainId: row.brain_id, cacheKey: row.cache_key, projectedCommit: row.projected_commit, schemaVersion: row.schema_version, ...(input.schemaPack ? { schemaPack: input.schemaPack } : {}), modelFingerprint: row.model_fingerprint, value: jsonValue(row.value, null), ...(row.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {}) } : undefined;
}

export async function invalidateScopedCache(store: Store, input: AnalyticsScope & { projectedCommit?: string; modelFingerprint?: string }): Promise<number> {
	scope(input);
	const rows = await store.query<{ id: string }>("DELETE FROM brain_cache_entries WHERE tenant_id = $1 AND brain_id = $2 AND ($3::text IS NULL OR projected_commit = $3) AND ($4::text IS NULL OR model_fingerprint = $4) RETURNING id", [input.tenantId, input.brainId, input.projectedCommit ?? null, input.modelFingerprint ?? null]);
	return rows.length;
}

export async function recordFact(store: Store, input: Omit<FactRecord, "id" | "metadata"> & { id?: string; metadata?: Record<string, unknown> }): Promise<FactRecord> {
	scope(input);
	if (!input.subject.trim() || !input.predicate.trim() || !input.objectValue.trim() || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error("invalid fact");
	const id = input.id ?? randomUUID();
	const metadata = withSchemaMetadata(input.metadata, input.schemaPack);
	await store.query("INSERT INTO brain_facts (id, tenant_id, brain_id, subject, predicate, object_value, document_id, chunk_id, confidence, valid_from, valid_to, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)", [id, input.tenantId, input.brainId, input.subject, input.predicate, input.objectValue, input.documentId ?? null, input.chunkId ?? null, input.confidence, input.validFrom ?? null, input.validTo ?? null, JSON.stringify(metadata)]);
	return { ...input, id, metadata };
}

export async function recordClaim(store: Store, input: Omit<ClaimRecord, "id" | "metadata"> & { id?: string; metadata?: Record<string, unknown> }): Promise<ClaimRecord> {
	scope(input);
	if (!input.claim.trim() || !["active", "retracted", "superseded"].includes(input.status) || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error("invalid claim");
	const id = input.id ?? randomUUID();
	const metadata = withSchemaMetadata(input.metadata, input.schemaPack);
	await store.query("INSERT INTO brain_claims (id, tenant_id, brain_id, fact_id, claim, status, confidence, document_id, chunk_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)", [id, input.tenantId, input.brainId, input.factId ?? null, input.claim, input.status, input.confidence, input.documentId ?? null, input.chunkId ?? null, JSON.stringify(metadata)]);
	return { ...input, id, metadata };
}

export async function recordTimelineEvent(store: Store, input: Omit<TimelineRecord, "id" | "metadata"> & { id?: string; metadata?: Record<string, unknown> }): Promise<TimelineRecord> {
	scope(input);
	if (!input.subject.trim() || !input.eventAt.trim() || Number.isNaN(Date.parse(input.eventAt)) || !input.label.trim()) throw new Error("invalid timeline event");
	const id = input.id ?? randomUUID();
	const metadata = withSchemaMetadata(input.metadata, input.schemaPack);
	await store.query("INSERT INTO brain_timelines (id, tenant_id, brain_id, subject, event_at, label, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)", [id, input.tenantId, input.brainId, input.subject, input.eventAt, input.label, JSON.stringify(metadata)]);
	return { ...input, id, metadata };
}
