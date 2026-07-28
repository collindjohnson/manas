import { createHash, randomUUID } from "node:crypto";

type Store = {
	query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]>;
	transaction<T>(action: (store: Store) => Promise<T>): Promise<T>;
};

export type JobStatus = "pending" | "running" | "complete" | "failed" | "cancelled";
export type DependencyFailurePolicy = "cancel" | "dead-letter" | "degraded";
export interface BrainJob<T = unknown> {
	id: string;
	tenantId: string;
	type: string;
	payload: T;
	status: JobStatus;
	priority: number;
	attempts: number;
	maxAttempts: number;
	workerId?: string;
	leaseExpiresAt?: string;
	availableAt: string;
	lastError?: string;
	idempotencyKey?: string;
	dependencyIds: string[];
	dependencyFailurePolicy: DependencyFailurePolicy;
	degradedInput?: boolean;
	deadLettered?: boolean;
	progress?: Record<string, unknown>;
}

export interface BrainJobEvent { id: string; tenantId: string; jobId: string; eventType: string; metadata: Record<string, unknown>; createdAt: string; }
export interface BrainJobAttachment { id: string; tenantId: string; jobId: string; name: string; contentHash: string; byteCount: number; createdAt: string; }

export interface BrainJobSchedule<T = unknown> {
	id: string;
	tenantId: string;
	type: string;
	payload: T;
	intervalSeconds: number;
	nextRunAt: string;
	enabled: boolean;
}

type JobRow = { id: string; tenant_id: string; type: string; payload: unknown; status: JobStatus; priority: number; attempts: number; max_attempts: number; worker_id: string | null; lease_expires_at: string | null; available_at: string; last_error: string | null; idempotency_key?: string | null; dependency_ids: unknown; dependency_failure_policy: DependencyFailurePolicy; degraded_input?: boolean; dead_lettered?: boolean; progress?: unknown };
type ScheduleRow = { id: string; tenant_id: string; type: string; payload: unknown; interval_seconds: number; next_run_at: string; enabled: boolean };

function toJob<T>(row: JobRow): BrainJob<T> {
	const dependencies = typeof row.dependency_ids === "string" ? JSON.parse(row.dependency_ids) : row.dependency_ids;
	if (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== "string")) throw new Error("invalid job dependencies");
	const progress = typeof row.progress === "string" ? JSON.parse(row.progress) : row.progress;
	if (progress !== undefined && (!progress || typeof progress !== "object" || Array.isArray(progress))) throw new Error("invalid job progress");
	if (!["cancel", "dead-letter", "degraded"].includes(row.dependency_failure_policy)) throw new Error("invalid dependency failure policy");
	return { id: row.id, tenantId: row.tenant_id, type: row.type, payload: typeof row.payload === "string" ? JSON.parse(row.payload) as T : row.payload as T, status: row.status, priority: row.priority, attempts: row.attempts, maxAttempts: row.max_attempts, workerId: row.worker_id ?? undefined, leaseExpiresAt: row.lease_expires_at ?? undefined, availableAt: row.available_at, lastError: row.last_error ?? undefined, ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}), dependencyIds: dependencies, dependencyFailurePolicy: row.dependency_failure_policy, ...(row.degraded_input ? { degradedInput: true } : {}), ...(row.dead_lettered ? { deadLettered: true } : {}), ...(progress ? { progress: progress as Record<string, unknown> } : {}) };
}

const jobColumns = "id, tenant_id, type, payload, status, priority, attempts, max_attempts, worker_id, lease_expires_at, available_at, last_error, idempotency_key, dependency_ids, dependency_failure_policy, degraded_input, dead_lettered, progress";

function toSchedule<T>(row: ScheduleRow): BrainJobSchedule<T> {
	return { id: row.id, tenantId: row.tenant_id, type: row.type, payload: typeof row.payload === "string" ? JSON.parse(row.payload) as T : row.payload as T, intervalSeconds: row.interval_seconds, nextRunAt: new Date(row.next_run_at).toISOString(), enabled: row.enabled };
}

export async function createJobSchedule<T>(store: Store, input: { type: string; payload: T; intervalSeconds: number; tenantId?: string; nextRunAt?: Date }): Promise<BrainJobSchedule<T>> {
	if (!input.type.trim() || !(input.tenantId ?? "local").trim() || !Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 1) throw new Error("invalid job schedule");
	const rows = await store.query<ScheduleRow>("INSERT INTO brain_job_schedules (id, tenant_id, type, payload, interval_seconds, next_run_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id, tenant_id, type, payload, interval_seconds, next_run_at, enabled", [randomUUID(), input.tenantId ?? "local", input.type, JSON.stringify(input.payload), input.intervalSeconds, (input.nextRunAt ?? new Date()).toISOString()]);
	return toSchedule<T>(rows[0]!);
}

export async function listJobSchedules(store: Store, tenantId = "local"): Promise<BrainJobSchedule[]> {
	const rows = await store.query<ScheduleRow>("SELECT id, tenant_id, type, payload, interval_seconds, next_run_at, enabled FROM brain_job_schedules WHERE tenant_id = $1 ORDER BY next_run_at ASC", [tenantId]);
	return rows.map(toSchedule);
}

export async function acquireSchedulerLease(store: Store, ownerId: string, leaseMs = 60_000, tenantId = "local", now = new Date()): Promise<boolean> {
	if (!ownerId.trim() || !tenantId.trim() || !Number.isInteger(leaseMs) || leaseMs < 1) throw new Error("invalid scheduler lease");
	const rows = await store.query<{ tenant_id: string }>("INSERT INTO brain_scheduler_leases (tenant_id, owner_id, lease_expires_at) VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, lease_expires_at = EXCLUDED.lease_expires_at, updated_at = now() WHERE brain_scheduler_leases.owner_id = $2 OR brain_scheduler_leases.lease_expires_at < $4 RETURNING tenant_id", [tenantId, ownerId, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString()]);
	return rows.length > 0;
}

export async function renewSchedulerLease(store: Store, ownerId: string, leaseMs = 60_000, tenantId = "local", now = new Date()): Promise<boolean> {
	if (!ownerId.trim() || !tenantId.trim() || !Number.isInteger(leaseMs) || leaseMs < 1) throw new Error("invalid scheduler lease");
	const rows = await store.query<{ tenant_id: string }>("UPDATE brain_scheduler_leases SET lease_expires_at = $3, updated_at = now() WHERE tenant_id = $1 AND owner_id = $2 RETURNING tenant_id", [tenantId, ownerId, new Date(now.getTime() + leaseMs).toISOString()]);
	return rows.length > 0;
}

export async function releaseSchedulerLease(store: Store, ownerId: string, tenantId = "local"): Promise<boolean> {
	if (!ownerId.trim() || !tenantId.trim()) throw new Error("invalid scheduler lease");
	const rows = await store.query<{ tenant_id: string }>("DELETE FROM brain_scheduler_leases WHERE tenant_id = $1 AND owner_id = $2 RETURNING tenant_id", [tenantId, ownerId]);
	return rows.length > 0;
}

export async function materializeDueSchedules(store: Store, tenantId = "local", now = new Date(), schedulerId?: string): Promise<BrainJob[]> {
	if (schedulerId && !(await acquireSchedulerLease(store, schedulerId, 60_000, tenantId, now))) return [];
	return store.transaction(async (transaction) => {
		const schedules = await transaction.query<ScheduleRow>("SELECT id, tenant_id, type, payload, interval_seconds, next_run_at, enabled FROM brain_job_schedules WHERE tenant_id = $1 AND enabled = true AND next_run_at <= $2 ORDER BY next_run_at ASC", [tenantId, now.toISOString()]);
		const jobs: BrainJob[] = [];
		for (const schedule of schedules) {
			const jobRows = await transaction.query<JobRow>(`INSERT INTO brain_jobs (id, tenant_id, type, payload, status, available_at) VALUES ($1, $2, $3, $4::jsonb, 'pending', $5) RETURNING ${jobColumns}`, [randomUUID(), schedule.tenant_id, schedule.type, typeof schedule.payload === "string" ? schedule.payload : JSON.stringify(schedule.payload), now.toISOString()]);
			jobs.push(toJob(jobRows[0]!));
			let next = new Date(schedule.next_run_at);
			while (next <= now) next = new Date(next.getTime() + schedule.interval_seconds * 1_000);
			await transaction.query("UPDATE brain_job_schedules SET next_run_at = $2, updated_at = now() WHERE id = $1", [schedule.id, next.toISOString()]);
		}
		return jobs;
	});
}

export async function enqueueJob<T>(store: Store, input: { type: string; payload: T; tenantId?: string; priority?: number; maxAttempts?: number; availableAt?: Date; dependencyIds?: string[]; dependencyFailurePolicy?: DependencyFailurePolicy; idempotencyKey?: string }): Promise<BrainJob<T>> {
	if (!input.type.trim() || !(input.tenantId ?? "local").trim() || input.idempotencyKey !== undefined && (!input.idempotencyKey.trim() || input.idempotencyKey.length > 256) || !Number.isInteger(input.priority ?? 0) || !Number.isInteger(input.maxAttempts ?? 3) || (input.maxAttempts ?? 3) < 1 || input.dependencyFailurePolicy !== undefined && !["cancel", "dead-letter", "degraded"].includes(input.dependencyFailurePolicy)) throw new Error("invalid job");
	const dependencyIds = input.dependencyIds ?? [];
	if (dependencyIds.some((id) => !id.trim()) || new Set(dependencyIds).size !== dependencyIds.length) throw new Error("invalid job dependencies");
	const tenantId = input.tenantId ?? "local";
	if (dependencyIds.length) {
		const rows = await store.query<{ id: string }>("SELECT id FROM brain_jobs WHERE tenant_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))", [tenantId, JSON.stringify(dependencyIds)]);
		if (rows.length !== dependencyIds.length) throw new Error("job dependencies must belong to the same tenant");
	}
	const id = randomUUID();
	const rows = await store.query<JobRow>(`INSERT INTO brain_jobs (id, tenant_id, type, payload, status, priority, max_attempts, available_at, idempotency_key, dependency_ids, dependency_failure_policy) VALUES ($1, $2, $3, $4::jsonb, 'pending', $5, $6, $7, $8, $9::jsonb, $10) ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING ${jobColumns}`, [id, tenantId, input.type, JSON.stringify(input.payload), input.priority ?? 0, input.maxAttempts ?? 3, (input.availableAt ?? new Date()).toISOString(), input.idempotencyKey ?? null, JSON.stringify(dependencyIds), input.dependencyFailurePolicy ?? "cancel"]);
	if (rows[0]) return toJob<T>(rows[0]);
	if (input.idempotencyKey) {
		const existing = await store.query<JobRow>(`SELECT ${jobColumns} FROM brain_jobs WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, input.idempotencyKey]);
		if (existing[0]) return toJob<T>(existing[0]);
	}
	throw new Error("job was not created");
}

export async function claimJob(store: Store, workerId: string, leaseMs = 60_000, now = new Date(), tenantId = "local"): Promise<BrainJob | undefined> {
	if (!workerId.trim() || !Number.isInteger(leaseMs) || leaseMs < 1) throw new Error("invalid job claim");
	return store.transaction(async (transaction) => {
		await transaction.query("UPDATE brain_jobs AS dependent SET status = CASE WHEN dependent.dependency_failure_policy = 'cancel' THEN 'cancelled' ELSE 'failed' END, dead_lettered = dependent.dependency_failure_policy = 'dead-letter', last_error = 'dependency failed or was cancelled', updated_at = now() WHERE dependent.tenant_id = $1 AND dependent.status = 'pending' AND dependent.dependency_failure_policy IN ('cancel', 'dead-letter') AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(dependent.dependency_ids) dependency(id) JOIN brain_jobs prerequisite ON prerequisite.id = dependency.id AND prerequisite.tenant_id = dependent.tenant_id WHERE prerequisite.status IN ('failed', 'cancelled'))", [tenantId]);
		const candidates = await transaction.query<JobRow>(`SELECT ${jobColumns} FROM brain_jobs job WHERE tenant_id = $1 AND dead_lettered = false AND ((status = 'pending' AND available_at <= $2) OR (status = 'running' AND lease_expires_at < $2)) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(job.dependency_ids) dependency(id) LEFT JOIN brain_jobs prerequisite ON prerequisite.id = dependency.id AND prerequisite.tenant_id = job.tenant_id WHERE prerequisite.id IS NULL OR (prerequisite.status <> 'complete' AND NOT (job.dependency_failure_policy = 'degraded' AND prerequisite.status IN ('failed', 'cancelled')))) ORDER BY priority DESC, created_at ASC LIMIT 1`, [tenantId, now.toISOString()]);
		const candidate = candidates[0];
		if (!candidate) return undefined;
		const lease = new Date(now.getTime() + leaseMs).toISOString();
		const rows = await transaction.query<JobRow>(`UPDATE brain_jobs SET status = 'running', worker_id = $2, lease_expires_at = $3, attempts = attempts + 1, degraded_input = dependency_failure_policy = 'degraded' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(dependency_ids) dependency(id) JOIN brain_jobs prerequisite ON prerequisite.id = dependency.id AND prerequisite.tenant_id = brain_jobs.tenant_id WHERE prerequisite.status IN ('failed', 'cancelled')), updated_at = now() WHERE id = $1 AND tenant_id = $4 AND dead_lettered = false AND ((status = 'pending' AND available_at <= $5) OR (status = 'running' AND lease_expires_at < $5)) RETURNING ${jobColumns}`, [candidate.id, workerId, lease, tenantId, now.toISOString()]);
		return rows[0] ? toJob(rows[0]) : undefined;
	});
}

export async function completeJob(store: Store, id: string, workerId: string, tenantId = "local"): Promise<void> {
	const rows = await store.query<{ id: string }>("UPDATE brain_jobs SET status = 'complete', worker_id = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'running' AND worker_id = $3 RETURNING id", [id, tenantId, workerId]);
	if (!rows.length) throw new Error("job is not leased by this worker");
}

export async function renewJobLease(store: Store, id: string, workerId: string, leaseMs = 60_000, now = new Date(), tenantId = "local"): Promise<BrainJob> {
	if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error("invalid job lease");
	const lease = new Date(now.getTime() + leaseMs).toISOString();
	const rows = await store.query<JobRow>(`UPDATE brain_jobs SET lease_expires_at = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'running' AND worker_id = $3 AND dead_lettered = false RETURNING ${jobColumns}`, [id, tenantId, workerId, lease]);
	if (!rows.length) throw new Error("job is not leased by this worker");
	return toJob(rows[0]!);
}

export async function cancelJob(store: Store, id: string, tenantId = "local"): Promise<void> {
	const rows = await store.query<{ id: string }>("UPDATE brain_jobs SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status IN ('pending', 'running') RETURNING id", [id, tenantId]);
	if (!rows.length) throw new Error("job cannot be cancelled");
}

export async function listJobs(store: Store, limit = 100, tenantId = "local"): Promise<BrainJob[]> {
	if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("invalid job limit");
	const rows = await store.query<JobRow>(`SELECT ${jobColumns} FROM brain_jobs WHERE tenant_id = $2 ORDER BY created_at DESC LIMIT $1`, [limit, tenantId]);
	return rows.map(toJob);
}

export async function runOneJob(store: Store, workerId: string, handlers: Record<string, (job: BrainJob) => Promise<void>>, options: { leaseMs?: number; now?: Date; retryAt?: Date; tenantId?: string } = {}): Promise<BrainJob | undefined> {
	const tenantId = options.tenantId ?? "local";
	await materializeDueSchedules(store, tenantId, options.now, workerId);
	const job = await claimJob(store, workerId, options.leaseMs, options.now, tenantId);
	if (!job) return undefined;
	try {
		const handler = handlers[job.type];
		if (!handler) throw new Error(`no handler registered for job type: ${job.type}`);
		await handler(job);
		await completeJob(store, job.id, workerId, tenantId);
		return { ...job, status: "complete", workerId: undefined, leaseExpiresAt: undefined };
	} catch (error) {
		await failJob(store, job.id, workerId, error instanceof Error ? error.message : "job handler failed", options.retryAt, tenantId);
		throw error;
	}
}

export async function failJob(store: Store, id: string, workerId: string, error: string, retryAt = new Date(), tenantId = "local"): Promise<JobStatus> {
	if (!error.trim()) throw new Error("job failure must include an error");
	const rows = await store.query<{ status: JobStatus }>("UPDATE brain_jobs SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END, dead_lettered = attempts >= max_attempts, worker_id = NULL, lease_expires_at = NULL, available_at = $4, last_error = $5, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'running' AND worker_id = $3 RETURNING status", [id, tenantId, workerId, retryAt.toISOString(), error.slice(0, 4_000)]);
	if (!rows.length) throw new Error("job is not leased by this worker");
	return rows[0]!.status;
}

export async function updateJobProgress(store: Store, id: string, workerId: string, progress: Record<string, unknown>, tenantId = "local"): Promise<void> {
	if (!progress || Array.isArray(progress) || Object.values(progress).some((value) => typeof value === "function")) throw new Error("invalid job progress");
	const rows = await store.query<{ id: string }>("UPDATE brain_jobs SET progress = $4::jsonb, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'running' AND worker_id = $3 AND dead_lettered = false RETURNING id", [id, tenantId, workerId, JSON.stringify(progress)]);
	if (!rows.length) throw new Error("job is not leased by this worker");
}

export async function recordJobEvent(store: Store, input: { jobId: string; tenantId?: string; eventType: string; metadata?: Record<string, unknown> }): Promise<BrainJobEvent> {
	const tenantId = input.tenantId ?? "local";
	if (!input.jobId.trim() || !tenantId.trim() || !input.eventType.trim()) throw new Error("invalid job event");
	const id = randomUUID();
	const rows = await store.query<{ id: string; created_at: string }>("INSERT INTO brain_job_events (id, tenant_id, job_id, event_type, metadata) SELECT $1, $2, $3, $4, $5::jsonb WHERE EXISTS (SELECT 1 FROM brain_jobs WHERE id = $3 AND tenant_id = $2) RETURNING id, created_at", [id, tenantId, input.jobId, input.eventType, JSON.stringify(input.metadata ?? {})]);
	if (!rows[0]) throw new Error("job is not in the tenant");
	return { id, tenantId, jobId: input.jobId, eventType: input.eventType, metadata: input.metadata ?? {}, createdAt: new Date(rows[0].created_at).toISOString() };
}

export async function attachJob(store: Store, input: { jobId: string; tenantId?: string; name: string; bytes: number; contentHash?: string }): Promise<BrainJobAttachment> {
	const tenantId = input.tenantId ?? "local";
	if (!input.jobId.trim() || !tenantId.trim() || !input.name.trim() || !Number.isInteger(input.bytes) || input.bytes < 0 || input.bytes > 256 * 1024 * 1024) throw new Error("invalid job attachment");
	const contentHash = input.contentHash ?? createHash("sha256").update(`${input.jobId}\0${input.name}\0${input.bytes}`).digest("hex");
	const id = randomUUID();
	const rows = await store.query<{ id: string; created_at: string }>("INSERT INTO brain_job_attachments (id, tenant_id, job_id, name, content_hash, byte_count) SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM brain_jobs WHERE id = $3 AND tenant_id = $2) RETURNING id, created_at", [id, tenantId, input.jobId, input.name, contentHash, input.bytes]);
	if (!rows[0]) throw new Error("job is not in the tenant");
	return { id, tenantId, jobId: input.jobId, name: input.name, contentHash, byteCount: input.bytes, createdAt: new Date(rows[0].created_at).toISOString() };
}

export async function cancelJobTree(store: Store, id: string, tenantId = "local"): Promise<number> {
	if (!id.trim() || !tenantId.trim()) throw new Error("invalid job cancellation");
	const rows = await store.query<{ count: string }>("WITH RECURSIVE tree AS (SELECT id FROM brain_jobs WHERE id = $1 AND tenant_id = $2 UNION ALL SELECT child.id FROM brain_jobs child JOIN tree parent ON child.tenant_id = $2 AND child.dependency_ids ? parent.id) UPDATE brain_jobs SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL, updated_at = now() WHERE tenant_id = $2 AND id IN (SELECT id FROM tree) AND status IN ('pending', 'running') RETURNING id", [id, tenantId]);
	return rows.length;
}
