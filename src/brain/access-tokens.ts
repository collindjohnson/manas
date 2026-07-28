import { createHash, randomBytes, randomUUID } from "node:crypto";
const auditModule = await import([".", "audit"].join(String.fromCharCode(47)));

type Store = { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]> };
export type AccessScope = "read" | "write" | "admin";
export interface PersonalAccessToken { id: string; tenantId: string; userId?: string; name: string; scopes: AccessScope[]; expiresAt?: string; revokedAt?: string; createdAt: string }

function hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function scopes(value: AccessScope[]): AccessScope[] {
	const normalized = [...new Set(value)].sort();
	if (!normalized.length || normalized.some((scope) => scope !== "read" && scope !== "write" && scope !== "admin")) throw new Error("invalid token scopes");
	return normalized;
}
function toToken(row: { id: string; tenant_id: string; user_id?: string | null; name: string; scopes: unknown; expires_at: string | Date | null; revoked_at: string | Date | null; created_at: string | Date }): PersonalAccessToken {
	const value = typeof row.scopes === "string" ? JSON.parse(row.scopes) : row.scopes;
	return { id: row.id, tenantId: row.tenant_id, ...(row.user_id ? { userId: row.user_id } : {}), name: row.name, scopes: scopes(value as AccessScope[]), expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined, revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined, createdAt: new Date(row.created_at).toISOString() };
}

export async function createPersonalAccessToken(store: Store, input: { name: string; scopes: AccessScope[]; tenantId?: string; userId?: string; expiresAt?: Date }): Promise<{ token: string; record: PersonalAccessToken }> {
	if (!input.name.trim() || !(input.tenantId ?? "local").trim() || input.userId !== undefined && !input.userId.trim() || (input.expiresAt && input.expiresAt <= new Date())) throw new Error("invalid personal access token");
	const token = randomBytes(32).toString("base64url");
	const rows = await store.query<{ id: string; tenant_id: string; user_id: string | null; name: string; scopes: unknown; expires_at: string | null; revoked_at: string | null; created_at: string }>("INSERT INTO brain_access_tokens (id, tenant_id, user_id, name, token_hash, scopes, expires_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id, tenant_id, user_id, name, scopes, expires_at, revoked_at, created_at", [randomUUID(), input.tenantId ?? "local", input.userId ?? null, input.name, hash(token), JSON.stringify(scopes(input.scopes)), input.expiresAt?.toISOString() ?? null]);
	const record = toToken(rows[0]!);
	await auditModule.recordAuditEvent(store, { tenantId: record.tenantId, action: "access_token.created", subjectId: record.id, metadata: { name: record.name, scopes: record.scopes, expiresAt: record.expiresAt ?? null } });
	return { token, record };
}

export async function listPersonalAccessTokens(store: Store, tenantId = "local"): Promise<PersonalAccessToken[]> {
	const rows = await store.query<{ id: string; tenant_id: string; user_id: string | null; name: string; scopes: unknown; expires_at: string | null; revoked_at: string | null; created_at: string }>("SELECT id, tenant_id, user_id, name, scopes, expires_at, revoked_at, created_at FROM brain_access_tokens WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]);
	return rows.map(toToken);
}

export async function revokePersonalAccessToken(store: Store, id: string, tenantId = "local"): Promise<void> {
	const rows = await store.query<{ id: string }>("UPDATE brain_access_tokens SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING id", [id, tenantId]);
	if (!rows.length) throw new Error("personal access token cannot be revoked");
	await auditModule.recordAuditEvent(store, { tenantId, action: "access_token.revoked", subjectId: id });
}

export async function authorizePersonalAccessToken(store: Store, token: string, scope: AccessScope, tenantId = "local", now = new Date()): Promise<boolean> {
	const rows = await store.query<{ scopes: unknown }>("SELECT scopes FROM brain_access_tokens WHERE token_hash = $1 AND tenant_id = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $3) LIMIT 1", [hash(token), tenantId, now.toISOString()]);
	if (!rows.length) return false;
	const value = typeof rows[0]!.scopes === "string" ? JSON.parse(rows[0]!.scopes as string) : rows[0]!.scopes;
	return Array.isArray(value) && (value.includes(scope) || (scope !== "admin" && value.includes("admin")));
}

export async function identifyPersonalAccessToken(store: Store, token: string, now = new Date()): Promise<{ id: string; tenantId: string; userId?: string } | undefined> {
	if (!token.trim()) return undefined;
	const rows = await store.query<{ id: string; tenant_id: string; user_id: string | null }>("SELECT id, tenant_id, user_id FROM brain_access_tokens WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) LIMIT 1", [hash(token), now.toISOString()]);
	return rows[0] ? { id: rows[0].id, tenantId: rows[0].tenant_id, ...(rows[0].user_id ? { userId: rows[0].user_id } : {}) } : undefined;
}
