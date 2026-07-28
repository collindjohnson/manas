import { randomUUID } from "node:crypto";
import { IdempotencyLedger } from "./job-policy";
import { recordAuditEvent } from "./audit";
import type { BrainStore } from "./store";

export interface AdminAuditReceipt {
	id: string;
	action: string;
	targetId: string;
	tenantId: string;
	principal: string;
	occurredAt: string;
}

export interface AdminActionContext {
	principal: string;
	tenantId: string;
	scope: "read" | "write" | "admin";
	idempotencyKey: string;
	confirmation?: string;
	now?: Date;
}

export interface DurableAdminActionReceipt<T = unknown> {
	id: string;
	action: string;
	targetId: string;
	tenantId: string;
	principal: string;
	idempotencyKey: string;
	status: "complete";
	result: T;
	occurredAt: string;
}

type DurableReceiptRow = {
	id: string;
	tenant_id: string;
	action: string;
	target_id: string;
	principal: string;
	idempotency_key: string;
	status: "running" | "complete" | "failed";
	result: unknown;
	error: string | null;
	created_at: string | Date;
};

type DurableStore = Pick<BrainStore, "query" | "transaction">;

function durableJson<T>(value: unknown): T {
	return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function durableError(value: unknown): string {
	return value instanceof Error ? value.message : "administrative action failed";
}

/**
 * Durable destructive-action boundary. Reservation happens before target
 * resolution so concurrent requests cannot perform the same action twice.
 * A completed receipt is replayed; running and failed receipts stay bound to
 * the idempotency key and never expose private result payloads in the audit.
 */
export class DurableAdminActionService {
	constructor(private readonly store: DurableStore, private readonly clock: () => Date = () => new Date()) {}

	async execute<T>(context: AdminActionContext, input: { action: string; targetId: string; confirmation: string; resolve: () => Promise<boolean>; perform: () => Promise<T> }): Promise<{ result: T; receipt: DurableAdminActionReceipt<T> }> {
		if (context.scope !== "admin" || !context.principal.trim() || !context.tenantId.trim() || !context.idempotencyKey.trim()) throw new Error("admin scope is required");
		if (!input.action.trim() || !input.targetId.trim() || context.confirmation !== input.confirmation || input.confirmation !== `${input.action} ${input.targetId}`) throw new Error("typed confirmation does not match target");
		const readExisting = async (): Promise<DurableReceiptRow | undefined> => (await this.store.query<DurableReceiptRow>("SELECT id, tenant_id, action, target_id, principal, idempotency_key, status, result, error, created_at FROM brain_admin_action_receipts WHERE tenant_id = $1 AND idempotency_key = $2", [context.tenantId, context.idempotencyKey]))[0];
		const replay = (row: DurableReceiptRow): { result: T; receipt: DurableAdminActionReceipt<T> } => {
			if (row.action !== input.action || row.target_id !== input.targetId || row.principal !== context.principal) throw new Error("idempotency key is bound to another administrative action");
			if (row.status === "running") throw new Error("administrative action is already in progress");
			if (row.status === "failed") throw new Error(row.error ?? "administrative action failed");
			return { result: durableJson<T>(row.result), receipt: { id: row.id, action: row.action, targetId: row.target_id, tenantId: row.tenant_id, principal: row.principal, idempotencyKey: row.idempotency_key, status: "complete", result: durableJson<T>(row.result), occurredAt: new Date(row.created_at).toISOString() } };
		};
		const existing = await readExisting();
		if (existing) return replay(existing);
		const reservedAt = this.clock().toISOString();
		const reserved = await this.store.transaction(async (transaction) => transaction.query<{ id: string }>("INSERT INTO brain_admin_action_receipts (id, tenant_id, action, target_id, principal, idempotency_key, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id", [randomUUID(), context.tenantId, input.action, input.targetId, context.principal, context.idempotencyKey, reservedAt]));
		if (!reserved.length) {
			const raced = await readExisting();
			if (!raced) throw new Error("administrative action reservation was lost");
			return replay(raced);
		}
		const fail = async (error: string): Promise<never> => {
			await this.store.transaction(async (transaction) => {
				await transaction.query("UPDATE brain_admin_action_receipts SET status = 'failed', error = $3, completed_at = $4 WHERE tenant_id = $1 AND idempotency_key = $2 AND status = 'running'", [context.tenantId, context.idempotencyKey, error.slice(0, 4_000), this.clock().toISOString()]);
				await recordAuditEvent(transaction, { tenantId: context.tenantId, action: "admin.action.rejected", subjectId: input.targetId, metadata: { principal: context.principal, action: input.action, receiptId: reserved[0]!.id, reason: error.slice(0, 256) } });
			});
			throw new Error(error);
		};
		if (!(await input.resolve())) return fail("admin target is stale or unavailable");
		let result: T;
		try { result = await input.perform(); } catch (error) { return fail(durableError(error)); }
		const receipt: DurableAdminActionReceipt<T> = { id: reserved[0]!.id, action: input.action, targetId: input.targetId, tenantId: context.tenantId, principal: context.principal, idempotencyKey: context.idempotencyKey, status: "complete", result, occurredAt: reservedAt };
		await this.store.transaction(async (transaction) => {
			await transaction.query("UPDATE brain_admin_action_receipts SET status = 'complete', result = $3::jsonb, completed_at = $4 WHERE tenant_id = $1 AND idempotency_key = $2 AND status = 'running'", [context.tenantId, context.idempotencyKey, JSON.stringify(result), receipt.occurredAt]);
			await recordAuditEvent(transaction, { tenantId: context.tenantId, action: "admin.action.completed", subjectId: input.targetId, metadata: { principal: context.principal, action: input.action, receiptId: receipt.id, idempotencyKey: context.idempotencyKey } });
		});
		return { result, receipt };
	}
}

export class AdminActionService {
	private readonly results = new IdempotencyLedger();
	constructor(private readonly audit: (receipt: AdminAuditReceipt) => Promise<void> | void) {}

	async execute<T>(context: AdminActionContext, input: { action: string; targetId: string; confirmation: string; resolve: () => Promise<boolean>; perform: () => Promise<T> }): Promise<{ result: T; receipt: AdminAuditReceipt }> {
		if (context.scope !== "admin" || !context.principal.trim() || !context.tenantId.trim() || !context.idempotencyKey.trim()) throw new Error("admin scope is required");
		if (!input.action.trim() || !input.targetId.trim() || context.confirmation !== input.confirmation || input.confirmation !== input.action + " " + input.targetId) throw new Error("typed confirmation does not match target");
		const cached = this.results.get<{ result: T; receipt: AdminAuditReceipt }>(context.idempotencyKey);
		if (cached) return cached;
		if (!(await input.resolve())) throw new Error("admin target is stale or unavailable");
		const result = await input.perform();
		const receipt: AdminAuditReceipt = { id: randomUUID(), action: input.action, targetId: input.targetId, tenantId: context.tenantId, principal: context.principal, occurredAt: (context.now ?? new Date()).toISOString() };
		await this.audit(receipt);
		return this.results.record(context.idempotencyKey, { result, receipt });
	}
}
