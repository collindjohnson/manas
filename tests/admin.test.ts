import { describe, expect, test } from "bun:test";
import { openPgliteBrainStore } from "../src/brain/store";

const modulePath = ["..", "src", "brain", "admin"].join(String.fromCharCode(47));
const { AdminActionService } = await import(modulePath);
const { DurableAdminActionService } = await import(modulePath);

describe("administrative action boundary", () => {
	test("requires typed confirmation, re-resolves targets, audits, and deduplicates", async () => {
		const audits: unknown[] = [];
		let performed = 0;
		const service = new AdminActionService(async (receipt: unknown) => { audits.push(receipt); });
		const context = { principal: "admin", tenantId: "tenant", scope: "admin" as const, idempotencyKey: "request-1", confirmation: "revoke token-1", now: new Date("2026-07-27T00:00:00Z") };
		const input = { action: "revoke", targetId: "token-1", confirmation: "revoke token-1", resolve: async () => true, perform: async () => { performed += 1; return { revoked: true }; } };
		const first = await service.execute(context, input);
		const second = await service.execute(context, input);
		expect(first).toEqual(second);
		expect(performed).toBe(1);
		expect(audits).toHaveLength(1);
	});

	test("rejects insufficient scope, mismatched confirmation, and stale targets", async () => {
		const service = new AdminActionService(async () => {});
		const base = { action: "purge", targetId: "doc", confirmation: "purge doc", resolve: async () => true, perform: async () => true };
		await expect(service.execute({ principal: "user", tenantId: "tenant", scope: "write", idempotencyKey: "1", confirmation: "purge doc" }, base)).rejects.toThrow("admin scope");
		await expect(service.execute({ principal: "admin", tenantId: "tenant", scope: "admin", idempotencyKey: "2", confirmation: "purge other" }, base)).rejects.toThrow("confirmation");
		await expect(service.execute({ principal: "admin", tenantId: "tenant", scope: "admin", idempotencyKey: "3", confirmation: "purge doc" }, { ...base, resolve: async () => false })).rejects.toThrow("stale");
	});

	test("persists destructive receipts, replays them, and keeps audit metadata redacted", async () => {
		const store = await openPgliteBrainStore();
		let performed = 0;
		try {
			const service = new DurableAdminActionService(store, () => new Date("2026-07-27T00:00:00Z"));
			const context = { principal: "admin", tenantId: "tenant-a", scope: "admin" as const, idempotencyKey: "durable-1", confirmation: "revoke token-a" };
			const input = { action: "revoke", targetId: "token-a", confirmation: "revoke token-a", resolve: async () => true, perform: async () => { performed += 1; return { revoked: true, secret: "never-log-this" }; } };
			const first = await service.execute(context, input);
			const second = await service.execute(context, input);
			expect(second).toEqual(first);
			expect(performed).toBe(1);
			await expect(service.execute({ ...context, principal: "other-admin" }, input)).rejects.toThrow("bound to another");
			expect(await store.query("SELECT tenant_id, action, target_id, status, result FROM brain_admin_action_receipts")).toMatchObject([{ tenant_id: "tenant-a", action: "revoke", target_id: "token-a", status: "complete" }]);
			const audit = await store.query<{ action: string; metadata: unknown }>("SELECT action, metadata FROM brain_audit_events WHERE tenant_id = $1 ORDER BY created_at", ["tenant-a"]);
			expect(audit).toMatchObject([{ action: "admin.action.completed" }]);
		expect(JSON.stringify(audit)).not.toContain("never-log-this");
		} finally { await store.close(); }
	});
});
