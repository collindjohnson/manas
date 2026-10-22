import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "operation-registry"].join(String.fromCharCode(47));
const { createBrainRepositoryOperationRegistry } = await import(modulePath);

describe("shared operation registry", () => {
	test("generates one scoped executable definition for every repository operation", async () => {
		const registry = createBrainRepositoryOperationRegistry({
			head: async () => "head",
			getSettings: async () => ({ schemaPack: { id: "default", version: "1" } }),
			listPages: async () => [],
		} as never);
		expect(registry.list().length).toBe(18);
		expect(registry.get("put_page")).toMatchObject({ requiredScope: "write", trustBoundary: "remote-safe" });
		expect(registry.get("brain_status")).toMatchObject({ requiredScope: "read" });
		await expect(registry.execute({ scope: "read" }, "put_page", { path: "a.md", content: "x", expectedHead: null })).rejects.toThrow("insufficient");
		await expect(registry.execute({ scope: "read" }, "brain_status", {})).resolves.toMatchObject({ pages: { active: 0 } });
	});

	test("rejects unknown and malformed operation input", async () => {
		const registry = createBrainRepositoryOperationRegistry({} as never);
		await expect(registry.execute({ scope: "read" }, "brain_status", { extra: true })).rejects.toThrow("unknown");
		expect(() => registry.get("missing")).toThrow("not registered");
	});
});

test("repository clients cannot bypass labels through reads, exports, history, or writes", async () => {
 const pages = [{ id: "public", path: "public.md", accessLabels: [] }, { id: "private", path: "private.md", accessLabels: ["secret"] }];
 const registry = createBrainRepositoryOperationRegistry({
  snapshot: async () => ({ brainId: "brain", commit: "head", pages }),
  readPage: async (_snapshot: unknown, id: string) => ({ id, content: id }),
  getPage: async (path: string) => ({ path }),
 } as never);
 const context = { scope: "write" as const, tenantId: "local", brainId: "brain", allowedAccessLabels: [] };
 expect(await registry.execute(context, "list_pages", {})).toEqual({ pages: [pages[0]] });
 expect(await registry.execute(context, "export_brain", {})).toMatchObject({ pages: [{ id: "public" }] });
 await expect(registry.execute(context, "get_page", { path: "private.md" })).rejects.toThrow("unavailable");
 await expect(registry.execute(context, "get_page_at", { path: "private.md", ref: "old" })).rejects.toThrow("unavailable");
 await expect(registry.execute(context, "page_history", { path: "public.md" })).rejects.toThrow("owner history");
 await expect(registry.execute(context, "put_page", { path: "private.md", content: "replace", expectedHead: "head" })).rejects.toThrow("unavailable");
 await expect(registry.execute({ ...context, tenantId: "other" }, "list_pages", {})).rejects.toThrow("not authorized");
});
