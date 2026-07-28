export const POSTGRES_CLAIM_JOB_SQL = "SELECT id, tenant_id, type, payload, status, priority, attempts, max_attempts, worker_id, lease_expires_at, available_at, last_error, idempotency_key, dependency_ids, dependency_failure_policy, degraded_input, dead_lettered, progress FROM brain_jobs WHERE tenant_id = $1 AND dead_lettered = false AND ((status = 'pending' AND available_at <= $2) OR (status = 'running' AND lease_expires_at < $2)) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(dependency_ids) dependency(id) LEFT JOIN brain_jobs prerequisite ON prerequisite.id = dependency.id AND prerequisite.tenant_id = brain_jobs.tenant_id WHERE prerequisite.id IS NULL OR (prerequisite.status <> 'complete' AND NOT (brain_jobs.dependency_failure_policy = 'degraded' AND prerequisite.status IN ('failed', 'cancelled')))) ORDER BY priority DESC, created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1";

export interface PostgresClaimedJob { id: string; tenantId: string; type: string; payload: unknown; attempts: number; maxAttempts: number; workerId: string; leaseExpiresAt: string; idempotencyKey?: string; dependencyFailurePolicy: "cancel" | "dead-letter" | "degraded"; degradedInput: boolean; }

export async function claimPostgresJob(store: { transaction<T>(action: (store: { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]> }) => Promise<T>): Promise<T> }, workerId: string, tenantId: string, leaseMs = 60_000, now = new Date()): Promise<PostgresClaimedJob | undefined> {
	if (!workerId.trim() || !tenantId.trim() || !Number.isInteger(leaseMs) || leaseMs < 1) throw new Error("invalid PostgreSQL job claim");
	return store.transaction(async (transaction) => {
		const rows = await transaction.query<{ id: string; tenant_id: string; type: string; payload: unknown; attempts: number; max_attempts: number; idempotency_key?: string | null; dependency_failure_policy: "cancel" | "dead-letter" | "degraded"; degraded_input?: boolean }>(POSTGRES_CLAIM_JOB_SQL, [tenantId, now.toISOString()]);
		const candidate = rows[0];
		if (!candidate) return undefined;
		const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
		const claimed = await transaction.query<{ id: string; degraded_input: boolean }>("UPDATE brain_jobs SET status = 'running', worker_id = $2, lease_expires_at = $3, attempts = attempts + 1, degraded_input = dependency_failure_policy = 'degraded' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(dependency_ids) dependency(id) JOIN brain_jobs prerequisite ON prerequisite.id = dependency.id AND prerequisite.tenant_id = brain_jobs.tenant_id WHERE prerequisite.status IN ('failed', 'cancelled')), updated_at = now() WHERE id = $1 AND tenant_id = $4 AND dead_lettered = false RETURNING id, degraded_input", [candidate.id, workerId, leaseExpiresAt, tenantId]);
		if (!claimed.length) return undefined;
		const dependencyFailurePolicy = candidate.dependency_failure_policy ?? "cancel";
		return { id: candidate.id, tenantId: candidate.tenant_id, type: candidate.type, payload: typeof candidate.payload === "string" ? JSON.parse(candidate.payload) : candidate.payload, attempts: candidate.attempts + 1, maxAttempts: candidate.max_attempts, workerId, leaseExpiresAt, dependencyFailurePolicy, degradedInput: claimed[0]!.degraded_input === true, ...(candidate.idempotency_key ? { idempotencyKey: candidate.idempotency_key } : {}) };
	});
}

export interface PgliteSchedulerLease { owner: string; acquiredAt: string; expiresAt: string; }

export function computeBackoff(attempt: number, baseMs = 1_000, maximumMs = 15 * 60_000, random = 0.5): number {
	if (!Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(baseMs) || baseMs < 1 || !Number.isInteger(maximumMs) || maximumMs < baseMs || !Number.isFinite(random) || random < 0 || random > 1) throw new Error("invalid job backoff");
	return Math.min(maximumMs, Math.floor(baseMs * 2 ** Math.min(attempt - 1, 20) * (0.5 + random)));
}

export function assertPgliteSchedulerOwner(current: PgliteSchedulerLease | undefined, owner: string, now = new Date()): void {
	if (!owner.trim()) throw new Error("scheduler owner is required");
	if (current && current.owner !== owner && current.expiresAt > now.toISOString()) throw new Error("PGLite scheduler is already owned");
}
