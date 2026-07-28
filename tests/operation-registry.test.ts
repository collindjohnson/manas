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
