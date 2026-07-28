import { randomUUID } from "node:crypto";

type Store = { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]> };
export interface AuditEvent { id: string; tenantId: string; action: string; subjectId?: string; metadata: Record<string, unknown>; createdAt: string }
export interface AuditEventPage { events: AuditEvent[]; nextCursor?: string }
export interface AuditCursor { createdAt: string; id: string }

export async function recordAuditEvent(store: Store, input: { action: string; tenantId?: string; subjectId?: string; metadata?: Record<string, unknown> }): Promise<AuditEvent> {
	if (!input.action.trim() || !(input.tenantId ?? "local").trim()) throw new Error("invalid audit event");
	const rows = await store.query<{ id: string; tenant_id: string; action: string; subject_id: string | null; metadata: unknown; created_at: string | Date }>("INSERT INTO brain_audit_events (id, tenant_id, action, subject_id, metadata) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id, tenant_id, action, subject_id, metadata, created_at", [randomUUID(), input.tenantId ?? "local", input.action, input.subjectId ?? null, JSON.stringify(input.metadata ?? {})]);
	const row = rows[0]!;
	return { id: row.id, tenantId: row.tenant_id, action: row.action, subjectId: row.subject_id ?? undefined, metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata as Record<string, unknown>, createdAt: new Date(row.created_at).toISOString() };
}

export async function listAuditEvents(store: Store, tenantId = "local", limit = 100): Promise<AuditEvent[]> {
	return (await listAuditEventsPage(store, { tenantId, limit })).events;
}

export function encodeAuditCursor(cursor: AuditCursor): string {
	if (!cursor.id.trim() || Number.isNaN(Date.parse(cursor.createdAt))) throw new Error("invalid audit cursor");
	return Buffer.from(JSON.stringify({ createdAt: new Date(cursor.createdAt).toISOString(), id: cursor.id }), "utf8").toString("base64url");
}

export function decodeAuditCursor(value: string): AuditCursor {
	if (!value.trim()) throw new Error("invalid audit cursor");
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<AuditCursor>;
		if (typeof parsed.id !== "string" || typeof parsed.createdAt !== "string") throw new Error("invalid audit cursor");
		return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id };
	} catch { throw new Error("invalid audit cursor"); }
}

export async function listAuditEventsPage(store: Store, options: { tenantId?: string; limit?: number; after?: string } = {}): Promise<AuditEventPage> {
	const tenantId = options.tenantId ?? "local";
	const limit = options.limit ?? 100;
	if (!tenantId.trim() || !Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("invalid audit event page");
	const cursor = options.after ? decodeAuditCursor(options.after) : undefined;
	const rows = await store.query<{ id: string; tenant_id: string; action: string; subject_id: string | null; metadata: unknown; created_at: string | Date }>("SELECT id, tenant_id, action, subject_id, metadata, created_at FROM brain_audit_events WHERE tenant_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2 OR (created_at = $2 AND id < $3)) ORDER BY created_at DESC, id DESC LIMIT $4", [tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]);
	const pageRows = rows.slice(0, limit);
	const events = pageRows.map((row) => ({ id: row.id, tenantId: row.tenant_id, action: row.action, subjectId: row.subject_id ?? undefined, metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata as Record<string, unknown>, createdAt: new Date(row.created_at).toISOString() }));
	const last = pageRows.at(-1);
	return { events, ...(rows.length > limit && last ? { nextCursor: encodeAuditCursor({ createdAt: new Date(last.created_at).toISOString(), id: last.id }) } : {}) };
}
