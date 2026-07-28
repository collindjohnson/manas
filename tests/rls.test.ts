import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "rls"].join(String.fromCharCode(47));
const { postgresRlsStatements, setPostgresTenantContext } = await import(modulePath);

describe("PostgreSQL tenant isolation", () => {
	test("generates RLS for every tenant-scoped operational table and chunks through documents", () => {
		const statements = postgresRlsStatements().join("\n");
		expect(statements).toContain("ALTER TABLE brain_documents ENABLE ROW LEVEL SECURITY");
		expect(statements).toContain("ALTER TABLE brain_jobs ENABLE ROW LEVEL SECURITY");
		expect(statements).toContain("ALTER TABLE brain_jobs FORCE ROW LEVEL SECURITY");
		expect(statements).toContain("ALTER TABLE brain_job_events ENABLE ROW LEVEL SECURITY");
		expect(statements).toContain("ALTER TABLE brain_job_attachments ENABLE ROW LEVEL SECURITY");
		expect(statements).toContain("ALTER TABLE brain_agent_runs ENABLE ROW LEVEL SECURITY");
		expect(statements).toContain("ALTER TABLE brain_memberships ENABLE ROW LEVEL SECURITY");
		expect(statements).toContain("ALTER TABLE brain_graph_nodes ENABLE ROW LEVEL SECURITY");
		expect(statements).toContain("ALTER TABLE brain_cache_entries FORCE ROW LEVEL SECURITY");
		expect(statements).toContain("ALTER TABLE brain_skill_feedback ENABLE ROW LEVEL SECURITY");
		expect(statements).toContain("ALTER TABLE brain_admin_action_receipts ENABLE ROW LEVEL SECURITY");
		expect(statements).toContain("ALTER TABLE brain_projection_documents ENABLE ROW LEVEL SECURITY");
		expect(statements).toContain("brain_chunk_tenant_isolation");
		expect(statements).toContain("brain_projection_chunk_tenant_isolation");
		expect(statements).toContain("brain_group_member_tenant_isolation");
		expect(statements).toContain("current_setting('app.tenant_id', true)");
		expect(statements).toContain("current_setting('app.user_id', true)");
		expect(statements).toContain("brain_memberships m");
		expect(statements).toContain("brain_members m");
	});

	test("sets tenant and user context through parameters", async () => {
		const calls: unknown[][] = [];
		await setPostgresTenantContext({ query: async (_sql: string, parameters?: unknown[]) => { calls.push(parameters ?? []); return []; } }, "tenant", "user");
		expect(calls).toEqual([["tenant"], ["user"]]);
		expect(() => setPostgresTenantContext({ query: async () => [] }, "bad" + String.fromCharCode(0))).toThrow("tenant");
	});
});
