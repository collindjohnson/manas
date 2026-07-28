import { describe, expect, test } from "bun:test";
import { DEFAULT_SCHEMA_PACK } from "../src/brain/schema";
import { SchemaUpgradeCoordinator, schemaContext } from "../src/brain/schema-upgrades";

describe("approved schema upgrade execution", () => {
	test("preserves bytes for compatible activation and creates a rollback receipt", async () => {
		const calls: unknown[][] = [];
		const coordinator = new SchemaUpgradeCoordinator({ head: async () => "head", setSchemaPack: async (...args: unknown[]) => { calls.push(args); return { settings: {}, commit: "new-head" }; } });
		const next = { ...DEFAULT_SCHEMA_PACK, version: "2", pathTypes: { ...DEFAULT_SCHEMA_PACK.pathTypes, "projects/": "project" } };
		const pages = [{ id: "a", path: "notes/a.md", content: "same bytes" }];
		const plan = coordinator.approve(coordinator.plan(DEFAULT_SCHEMA_PACK, next, pages).id, "head");
		const result = await coordinator.apply(plan.id, { to: next, pages });
		expect(result).toMatchObject({ commit: "new-head", rollback: { pack: { id: "default", version: "1" }, expectedHead: "new-head" } });
		expect(calls[0]).toEqual([next, "head"]);
		await coordinator.rollback(plan.id, "new-head");
		expect(calls[1]).toEqual([{ id: "default", version: "1" }, "new-head"]);
		expect(schemaContext(next).fingerprint).not.toBe(schemaContext(DEFAULT_SCHEMA_PACK).fingerprint);
	});

	test("requires an explicit migration callback for incompatible changes and rejects stale pages", async () => {
		const coordinator = new SchemaUpgradeCoordinator({ head: async () => "head", setSchemaPack: async () => ({ settings: {}, commit: "commit" }) });
		const next = { ...DEFAULT_SCHEMA_PACK, version: "2", pathTypes: { ...DEFAULT_SCHEMA_PACK.pathTypes, "notes/": "project" } };
		const plan = coordinator.approve(coordinator.plan(DEFAULT_SCHEMA_PACK, next, [{ id: "a", path: "notes/a.md", content: "bytes" }]).id, "head");
		await expect(coordinator.apply(plan.id, { to: next, pages: [{ id: "a", path: "notes/a.md", content: "bytes" }] })).rejects.toThrow("migration");
		await expect(coordinator.apply(plan.id, { to: next, pages: [{ id: "a", path: "notes/a.md", content: "changed" }], migrate: async (page) => page })).rejects.toThrow("stale");
	});
});
