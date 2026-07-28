import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "tenancy"].join(String.fromCharCode(47));
const { SqlTenantDirectory, TenantDirectory } = await import(modulePath);

describe("tenant and brain authorization", () => {
	test("resolves tenant and brain membership before exposing scoped rows", () => {
		const directory = new TenantDirectory();
		directory.addTenant({ id: "tenant-a", name: "A" });
		directory.addTenant({ id: "tenant-b", name: "B" });
		directory.addBrain({ id: "brain-a", tenantId: "tenant-a", name: "A brain" });
		directory.addBrain({ id: "brain-b", tenantId: "tenant-b", name: "B brain" });
		directory.grant({ userId: "user", tenantId: "tenant-a", brainId: "brain-a", role: "member", visibilityLabels: ["team"] });
		const rows = [{ tenantId: "tenant-a", brainId: "brain-a", id: "visible", accessLabels: ["team"] }, { tenantId: "tenant-b", brainId: "brain-b", id: "hidden" }, { tenantId: "tenant-a", brainId: "brain-a", id: "private", accessLabels: ["private"] }];
		expect(directory.filterVisible("user", rows, "read").map((row: { id: string }) => row.id)).toEqual(["visible"]);
		expect(() => directory.authorize("user", "tenant-b", "brain-b", "read")).toThrow("scope");
		expect(directory.listBrains("user", "tenant-a").map((brain: { id: string }) => brain.id)).toEqual(["brain-a"]);
	});

	test("enforces write and admin scope hierarchy", () => {
		const directory = new TenantDirectory();
		directory.addTenant({ id: "tenant", name: "Tenant" });
		directory.addBrain({ id: "brain", tenantId: "tenant", name: "Brain" });
		directory.grant({ userId: "member", tenantId: "tenant", brainId: "brain", role: "member", visibilityLabels: [] });
		directory.grant({ userId: "admin", tenantId: "tenant", brainId: "brain", role: "admin", visibilityLabels: [] });
		expect(() => directory.authorize("member", "tenant", "brain", "write")).toThrow("authorized");
		expect(() => directory.authorize("admin", "tenant", "brain", "write")).not.toThrow();
		expect(() => directory.authorize("admin", "tenant", "brain", "admin")).toThrow("authorized");
	});

	test("persists tenant and brain membership through the shared SQL schema", async () => {
		const calls: Array<{ sql: string; parameters: unknown[] }> = [];
		const sqlStore = { query: async <T extends Record<string, unknown>>(sql: string, parameters?: unknown[]) => {
			calls.push({ sql, parameters: parameters ?? [] });
			if (sql.startsWith("SELECT membership")) return [{ role: "member", visibility_labels: ["team"] }] as unknown as T[];
			if (sql.startsWith("SELECT DISTINCT")) return [{ id: "brain", tenant_id: "tenant", name: "Brain", canonical_remote: null }] as unknown as T[];
			return [{ id: "created" }] as unknown as T[];
		} };
		const directory = new SqlTenantDirectory(sqlStore as never);
		await directory.addUser("user");
		await directory.addTenant({ id: "tenant", name: "Tenant" });
		await directory.addBrain({ id: "brain", tenantId: "tenant", name: "Brain" });
		await directory.grant({ userId: "user", tenantId: "tenant", brainId: "brain", role: "member", visibilityLabels: ["team"] });
		await expect(directory.authorize("user", "tenant", "brain", "read", ["team"])).resolves.toBeUndefined();
		expect(await directory.authorizeWithLabels("user", "tenant", "brain", "read")).toEqual({ allowedAccessLabels: ["team"] });
		expect(await directory.listBrains("user", "tenant")).toEqual([{ id: "brain", tenantId: "tenant", name: "Brain" }]);
		expect(calls.some((call) => call.sql.includes("brain_members"))).toBe(true);
	});

	test("honors group visibility grants in the durable SQL directory", async () => {
		const calls: string[] = [];
		const store = { query: async <T extends Record<string, unknown>>(sql: string): Promise<T[]> => {
			calls.push(sql);
			if (sql.startsWith("SELECT membership")) return [{ role: "member", visibility_labels: ["private"] }] as unknown as T[];
			if (sql.startsWith("SELECT label FROM brain_visibility_grants")) return [{ label: "team" }] as unknown as T[];
			return [] as T[];
		} };
		const directory = new SqlTenantDirectory(store);
		await expect(directory.authorize("user", "tenant", "brain", "read", ["team"])).resolves.toBeUndefined();
		expect(calls.some((sql) => sql.startsWith("SELECT label FROM brain_visibility_grants"))).toBe(true);
	});
});
