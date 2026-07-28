import { describe, expect, test } from "bun:test";
import { openPgliteBrainStore } from "../src/brain/store";
import { DurableControlPlane, redactAdminEvent, type ControlPlaneContext } from "../src/brain/control-plane";
import { recordAuditEvent } from "../src/brain/audit";

describe("durable hosted control plane", () => {
	test("persists tenant, brain, source, OAuth, session, quota, and dashboard state", async () => {
		const store = await openPgliteBrainStore();
		try {
			const admin: ControlPlaneContext = { principal: "owner", tenantId: "tenant-a", scope: "admin" };
			const control = new DurableControlPlane(store, () => new Date("2026-01-01T00:00:00.000Z"));
			await control.createUser(admin, { id: "owner" });
			await control.createTenant(admin, { id: "tenant-a", name: "A", ownerUserId: "owner" });
			await control.createBrain(admin, { id: "brain-a", name: "A brain", canonicalRemote: "https://git.invalid/a" });
			await control.grantMembership(admin, { userId: "owner", brainId: "brain-a", role: "owner", visibilityLabels: ["private"] });
			const group = await control.createGroup(admin, { id: "team-a", name: "Team A" });
			await control.addGroupMember(admin, { groupId: group.id, userId: "owner" });
			expect(await control.grantVisibility(admin, { brainId: "brain-a", subjectType: "group", subjectId: group.id, label: "team" })).toMatchObject({ tenantId: "tenant-a", brainId: "brain-a", subjectType: "group", label: "team" });
			await control.registerSource(admin, { id: "source-a", brainId: "brain-a", version: "1", kind: "filesystem", compatibility: { min: "1" } });
			expect(await control.listSources(admin)).toMatchObject([{ id: "source-a", brainId: "brain-a", enabled: true }]);
			await control.setSourceEnabled(admin, "source-a", false);
			await control.registerOAuthClient(admin, { id: "client-a", name: "CLI", redirectUris: ["http://127.0.0.1/callback"], scopes: ["read", "write"] });
			const session = await control.createWebSession(admin, "owner");
			expect(await control.validateWebSession(admin, session.id, session.csrfToken, true)).toMatchObject({ userId: "owner", tenantId: "tenant-a" });
			await expect(control.validateWebSession({ ...admin, tenantId: "tenant-b" }, session.id, session.csrfToken)).rejects.toThrow("expired session");
			expect(await control.consumeQuota({ ...admin, scope: "write", principal: "owner" }, { operation: "search", units: 2, limit: 3, windowMs: 60_000 })).toMatchObject({ used: 2, remaining: 1 });
			await expect(control.consumeQuota(admin, { operation: "search", units: 2, limit: 3, windowMs: 60_000 })).rejects.toThrow("quota");
			expect(await control.dashboard(admin)).toMatchObject({ tenantId: "tenant-a", brains: 1, users: 1, sources: 1, activeJobs: 0 });
			await recordAuditEvent(store, { tenantId: "tenant-a", action: "admin.test", metadata: { content: "private", count: 1 } });
			expect(await control.listAudit(admin)).toContainEqual(expect.objectContaining({ action: "admin.test", metadata: { count: 1 } }));
			const page = await control.listAuditPage(admin, 1);
			expect(page.events).toHaveLength(1);
			expect(page.nextCursor).toBeString();
			expect((await control.listAuditPage(admin, 100, page.nextCursor)).events.some((event) => event.id !== page.events[0]!.id)).toBe(true);
			expect((await control.listAudit(admin)).length).toBeGreaterThanOrEqual(5);
		} finally { await store.close(); }
	});

	test("persists two-phase agent runs, schema approval, rollback receipts, and redacts event content", async () => {
		const store = await openPgliteBrainStore();
		try {
			const context: ControlPlaneContext = { principal: "owner", tenantId: "tenant-a", scope: "admin" };
			const control = new DurableControlPlane(store);
			await store.query("INSERT INTO brain_users (id) VALUES ('owner')");
			await store.query("INSERT INTO brain_tenants (id, name) VALUES ('tenant-a', 'A')");
			await store.query("INSERT INTO brain_memberships (user_id, tenant_id, role) VALUES ('owner', 'tenant-a', 'owner')");
			await store.query("INSERT INTO brain_registry (id, tenant_id, name) VALUES ('brain-a', 'tenant-a', 'A')");
			const run = await control.createAgentRun(context, { brainId: "brain-a", agent: "codex", operation: "summarize", baseCommit: "abc", policy: { authority: "write", dryRun: false, ownedPaths: ["notes"] }, plannedPaths: ["notes"] });
			expect(run.status).toBe("planned");
			const proposal = await control.updateAgentRun(context, run.id, { status: "proposed", proposal: { runId: run.id, paths: ["notes/a.md"], changes: [{ path: "notes/a.md", content: "managed" }], cost: 1, createdAt: "2026-01-01T00:00:00.000Z" } });
			expect(proposal.status).toBe("proposed");
			const restarted = new DurableControlPlane(store);
			expect(await restarted.listRecoverableAgentRuns(context)).toMatchObject([{ id: run.id, status: "proposed", proposal: proposal.proposal }]);
			expect(await control.getAgentRun(context, run.id)).toMatchObject({ id: run.id, status: "proposed" });
			await expect(control.updateAgentRun(context, run.id, { status: "planned" })).rejects.toThrow("transition");
			const receipt = await control.recordRollback(context, { brainId: "brain-a", runId: run.id, targetKind: "agent-run", targetId: run.id, rollbackRef: "HEAD~1", metadata: { reason: "drill" } });
			expect(receipt.rollbackRef).toBe("HEAD~1");
			const plan = await control.planSchemaUpgrade(context, { brainId: "brain-a", fromVersion: "1", toVersion: "2", changes: [{ path: "notes/a.md", to: "note", byteChange: false }] });
			expect((await control.approveSchemaUpgrade(context, plan.id)).status).toBe("approved");
			await control.setSchemaUpgradeStatus(context, plan.id, "applied");
			expect((await store.query<{ status: string }>("SELECT status FROM brain_schema_upgrade_plans WHERE id = $1", [plan.id]))[0]!.status).toBe("applied");
			expect(await control.recordMigrationDrill(context, { brainId: "brain-a", stage: "rollback", status: "passed", evidence: { legacyRetained: true } })).toMatchObject({ brainId: "brain-a", stage: "rollback", status: "passed" });
			expect(redactAdminEvent({ id: "e", tenantId: "tenant-a", action: "x", metadata: { content: "private", count: 1 }, createdAt: "now" })).toMatchObject({ metadata: { count: 1 } });
		} finally { await store.close(); }
	});

	test("renews idle sessions without exceeding the absolute lifetime", async () => {
		const store = await openPgliteBrainStore();
		let now = new Date("2026-01-01T00:00:00.000Z");
		try {
			const context: ControlPlaneContext = { principal: "owner", tenantId: "tenant-a", scope: "write" };
			const control = new DurableControlPlane(store, () => now);
			const session = await control.createWebSession(context, "owner", { idleMs: 1_000, absoluteMs: 10_000 });
			now = new Date("2026-01-01T00:00:00.500Z");
			const refreshed = await control.validateWebSession(context, session.id, session.csrfToken);
			expect(refreshed.idleExpiresAt).toBe("2026-01-01T00:00:10.000Z");
			const persisted = (await store.query<{ last_seen_at: string | Date; idle_expires_at: string | Date }>("SELECT last_seen_at, idle_expires_at FROM brain_web_sessions WHERE tenant_id = $1", [context.tenantId]))[0]!;
			expect(new Date(persisted.last_seen_at).toISOString()).toBe("2026-01-01T00:00:00.500Z");
			expect(new Date(persisted.idle_expires_at).toISOString()).toBe("2026-01-01T00:00:10.000Z");
			now = new Date("2026-01-01T00:00:10.001Z");
			await expect(control.validateWebSession(context, session.id, session.csrfToken)).rejects.toThrow("expired session");
		} finally { await store.close(); }
	});
});
