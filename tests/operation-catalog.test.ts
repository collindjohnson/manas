import { describe, expect, test } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ALL_OPERATION_NAMES, CONTROL_OPERATION_CATALOG, assertOperationCatalog, createFullOperationRegistry } from "../src/brain/operation-catalog";
import { BrainRepository } from "../src/brain/repository";
import { openPgliteBrainStore } from "../src/brain/store";
import { indexBrainRepositoryIsolated } from "../src/brain/pglite-indexer";
import { DurableControlPlane } from "../src/brain/control-plane";

const execFile = promisify(execFileCallback);

describe("complete operation catalog", () => {
	test("classifies every operation once with a scope and trust boundary", () => {
		assertOperationCatalog();
		expect(new Set(ALL_OPERATION_NAMES).size).toBe(ALL_OPERATION_NAMES.length);
		expect(CONTROL_OPERATION_CATALOG.length).toBeGreaterThan(20);
		expect(CONTROL_OPERATION_CATALOG.every((entry) => entry.name.includes(".") && entry.scope && entry.boundary)).toBe(true);
	});

	test("generates one executable full registry and runs dependency-free skills operations", async () => {
		const registry = createFullOperationRegistry({ head: async () => undefined, listPages: async () => [], getSettings: async () => ({ schemaPack: {} }) } as never);
		expect(registry.list().length).toBe(18 + CONTROL_OPERATION_CATALOG.length);
		expect(registry.get("admin.dashboard")).toMatchObject({ requiredScope: "admin", trustBoundary: "remote-safe" });
		expect(await registry.execute({ scope: "read", tenantId: "tenant-a", principal: "reader" }, "skills.list", {})).toHaveLength(5);
		expect(await registry.execute({ scope: "read", tenantId: "tenant-a", principal: "reader" }, "skills.push-context", { agent: "codex", query: "q", citations: ["doc:chunk"], confidence: 0.9 })).toMatchObject({ status: "pushed" });
		expect(await registry.execute({ scope: "write", tenantId: "tenant-a", principal: "writer" }, "skills.feedback", { skillId: "brain-search", agent: "codex", outcome: "used" })).toMatchObject({ skillId: "brain-search", outcome: "used" });
		expect(await registry.execute({ scope: "write", tenantId: "tenant-a", principal: "writer" }, "skills.optimizer-propose", { skillId: "brain-search", version: "1.0.0", evidence: "replay", expectedImprovement: "raise recall" })).toMatchObject({ requiresApproval: true });
		expect(await registry.execute({ scope: "read", tenantId: "tenant-a", principal: "reader" }, "analysis.features", {})).toHaveLength(7);
		expect(await registry.execute({ scope: "read", tenantId: "tenant-a", principal: "reader" }, "analysis.code", { path: "src/example.ts", content: "function answer() { return answer(); }" })).toMatchObject({ symbols: [{ name: "answer" }] });
		expect(await registry.execute({ scope: "read", tenantId: "tenant-a", principal: "reader" }, "analysis.route.sources", { tenantId: "tenant-a", query: "parity", sources: [{ id: "a", tenantId: "tenant-a", priority: 2, healthy: true }, { id: "b", tenantId: "tenant-b", priority: 9, healthy: true }] })).toEqual({ tenantId: "tenant-a", sourceIds: ["a"], query: "parity" });
			expect(await registry.execute({ scope: "write", tenantId: "tenant-a", principal: "writer" }, "maintenance.propose", { tenantId: "tenant-a", brainId: "brain-a", findings: ["stale index"] })).toMatchObject({ dryRun: true, proposals: [{ requiresApproval: true }] });
		expect(await registry.execute({ scope: "read", tenantId: "tenant-a", principal: "reader" }, "analysis.anomaly", { records: [{ id: "metric", tenantId: "tenant-a", brainId: "brain-a", baseline: 1, observed: 4, threshold: 1 }] })).toMatchObject([{ id: "metric", severity: "critical" }]);
		expect(await registry.execute({ scope: "read", tenantId: "tenant-a", principal: "reader" }, "analysis.scorecard", { id: "launch", metrics: [{ id: "quality", value: 1, weight: 1 }] })).toMatchObject({ id: "launch", score: 1 });
		expect(await registry.execute({ scope: "read", tenantId: "tenant-a", principal: "reader" }, "analysis.recall", { records: [{ id: "memory", tenantId: "tenant-a", brainId: "brain-a", text: "launch plan" }], tenantId: "tenant-a", brainId: "brain-a", query: "launch" })).toMatchObject([{ id: "memory" }]);
		await expect(registry.execute({ scope: "read", tenantId: "tenant-a", principal: "reader" }, "analysis.route.sources", { tenantId: "tenant-b", query: "private", sources: [] })).rejects.toThrow("tenant scope");
		await expect(registry.execute({ scope: "admin", tenantId: "tenant-a", principal: "reader" }, "admin.dashboard", {})).rejects.toThrow("dependency");
	});

	test("executes durable job schedules through the shared catalog", async () => {
		const store = await openPgliteBrainStore();
		try {
			const registry = createFullOperationRegistry({ repository: { head: async () => undefined, listPages: async () => [], getSettings: async () => ({ schemaPack: {} }) } as never, store });
			const scheduled = await registry.execute({ scope: "write", tenantId: "tenant-a", principal: "writer" }, "jobs.schedule", { type: "report", payload: { format: "json" }, intervalSeconds: 60, nextRunAt: "2026-07-27T00:00:00.000Z" });
			expect(scheduled).toMatchObject({ tenantId: "tenant-a", type: "report", intervalSeconds: 60, enabled: true });
			expect(await registry.execute({ scope: "read", tenantId: "tenant-a", principal: "reader" }, "jobs.schedules", {})).toMatchObject([{ type: "report", tenantId: "tenant-a" }]);
			expect(await registry.execute({ scope: "write", tenantId: "tenant-a", brainId: "brain-a", principal: "writer" }, "skills.feedback", { id: "catalog-feedback", skillId: "brain-search", version: "1.0.0", agent: "codex", outcome: "used", confidence: 0.8 })).toMatchObject({ id: "catalog-feedback", tenantId: "tenant-a", brainId: "brain-a" });
			expect(await registry.execute({ scope: "read", tenantId: "tenant-a", brainId: "brain-a", principal: "reader" }, "skills.feedback.list", {})).toMatchObject([{ id: "catalog-feedback", skillId: "brain-search" }]);
			await expect(registry.execute({ scope: "write", tenantId: "tenant-a", principal: "writer" }, "jobs.schedule", { type: "report", payload: {}, intervalSeconds: 0 })).rejects.toThrow("below the minimum");
		} finally { await store.close(); }
	});

	test("executes verified retrieval, reasoning, model, security, and drill operations end to end", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-operation-catalog-"));
		const repository = new BrainRepository(join(root, "brain"));
		const store = await openPgliteBrainStore(join(root, "projection"));
		try {
			await repository.initialize();
			await execFile("git", ["-C", repository.root, "config", "user.name", "Catalog Test"]);
			await execFile("git", ["-C", repository.root, "config", "user.email", "catalog@example.invalid"]);
			await repository.putPage("notes/catalog.md", "The local brain stores durable memory.");
			const privatePage = await repository.putPage("notes/private.md", "Private tenant retrieval must not leak.");
			await repository.setPageAccessLabels(privatePage.path, ["private"], privatePage.revision, privatePage.commit);
			await indexBrainRepositoryIsolated(store, repository);
			const snapshot = await repository.snapshot();
			const registry = createFullOperationRegistry({ repository, store, controlPlane: new DurableControlPlane(store) });
			const context = { scope: "admin" as const, tenantId: "local", brainId: snapshot.brainId, principal: "catalog-test" };
			expect(await registry.execute(context, "admin.user.create", { id: "user-a" })).toEqual({ id: "user-a" });
			expect(await registry.execute(context, "admin.tenant.create", { id: "local", name: "Local Tenant", ownerUserId: "user-a" })).toMatchObject({ id: "local", name: "Local Tenant" });
			expect(await registry.execute(context, "admin.brain.create", { id: "brain-a", name: "Brain A", canonicalRemote: "https://example.invalid/brain.git" })).toMatchObject({ id: "brain-a", tenantId: "local" });
			expect(await registry.execute(context, "admin.membership.grant", { userId: "user-a", brainId: "brain-a", role: "member", visibilityLabels: ["team"] })).toBeUndefined();
			expect(await registry.execute(context, "admin.group.create", { id: "group-a", name: "Team A" })).toMatchObject({ id: "group-a", tenantId: "local" });
			expect(await registry.execute(context, "admin.group.member-add", { groupId: "group-a", userId: "user-a" })).toBeUndefined();
			expect(await registry.execute(context, "admin.visibility.grant", { brainId: "brain-a", subjectType: "user", subjectId: "user-a", label: "team" })).toMatchObject({ brainId: "brain-a", label: "team" });
			expect(await registry.execute(context, "admin.source.register", { id: "source-a", brainId: "brain-a", version: "1.0.0", kind: "filesystem" })).toBeUndefined();
			const disabledSource = await registry.execute(context, "sources.enable", { id: "source-a", enabled: false, confirmation: "sources.enable source-a", idempotencyKey: "disable-source-a" });
			expect(disabledSource).toMatchObject({ result: { id: "source-a", enabled: false }, receipt: { action: "sources.enable", status: "complete" } });
			expect(await registry.execute(context, "sources.enable", { id: "source-a", enabled: false, confirmation: "sources.enable source-a", idempotencyKey: "disable-source-a" })).toEqual(disabledSource);
			expect(await registry.execute(context, "admin.oauth-client.create", { id: "client-a", name: "Client A", redirectUris: ["https://example.invalid/callback"], scopes: ["read", "write"] })).toEqual({ id: "client-a" });
			expect(await registry.execute(context, "admin.oauth-client.revoke", { id: "client-a", confirmation: "admin.oauth-client.revoke client-a", idempotencyKey: "revoke-client-a" })).toMatchObject({ result: { id: "client-a", revoked: true }, receipt: { action: "admin.oauth-client.revoke", targetId: "client-a", status: "complete" } });
			const token = await registry.execute(context, "admin.token.create", { name: "Catalog token", scopes: ["read"], userId: "user-a" }) as { token: string; record: { id: string; tenantId: string } };
			expect(token).toMatchObject({ record: { tenantId: "local" }, token: expect.any(String) });
			expect(await registry.execute(context, "admin.token.list", {})).toMatchObject([{ id: token.record.id, userId: "user-a" }]);
			expect(await registry.execute(context, "admin.token.revoke", { id: token.record.id, confirmation: `admin.token.revoke ${token.record.id}`, idempotencyKey: "revoke-token-a" })).toMatchObject({ result: { id: token.record.id, revoked: true }, receipt: { action: "admin.token.revoke", targetId: token.record.id, status: "complete" } });
			expect(await registry.execute(context, "retrieval.search", { query: "durable memory" })).toMatchObject({ results: [{ path: "notes/catalog.md" }] });
			expect(await registry.execute(context, "reasoning.answer", { question: "durable memory" })).toMatchObject({ citations: [{ path: "notes/catalog.md" }] });
			expect(await registry.execute(context, "models.activate", { kind: "generation", fingerprint: "local-fingerprint" })).toMatchObject({ active: true });
			expect(await registry.execute(context, "security.check", {})).toMatchObject({ status: "checked", repository: { valid: true } });
			expect(await registry.execute(context, "integrity.check", {})).toMatchObject({ status: "checked", repository: { valid: true } });
			expect(await registry.execute(context, "cache.inspect", {})).toMatchObject({ tenantId: "local", entries: 0 });
			expect(await registry.execute(context, "migration.drill", { stage: "rollback" })).toMatchObject({ stage: "rollback", status: "planned" });
			expect(await registry.execute(context, "admin.audit.page", { limit: 1 })).toMatchObject({ events: expect.any(Array) });
			const memberContext = { ...context, scope: "read" as const, userId: "member", authorize: async () => ({ allowedAccessLabels: ["team"] }) };
			expect(await registry.execute(memberContext, "retrieval.search", { query: "private tenant retrieval" })).toMatchObject({ results: [] });
		} finally { await store.close(); await rm(root, { recursive: true, force: true }); }
	});
});
