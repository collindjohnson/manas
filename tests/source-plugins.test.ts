import { describe, expect, test } from "bun:test";
import type { SourcePlugin } from "../src/sources/plugins";

const modulePath = ["..", "src", "sources", "plugins"].join(String.fromCharCode(47));
const { SourcePluginRegistry, verifySourcePlugin } = await import(modulePath);

function plugin(version = "1", trusted = true): SourcePlugin {
	const descriptor = { id: "fixture", version, kind: "test", trusted };
	return { descriptor, create: () => ({ id: "fixture", describe: () => descriptor, async *scan() { yield { externalId: "one", suggestedPath: "fixture/one.md", content: "hello", deleted: false, provenance: { sourceType: "fixture", retrievedAt: "2026-07-24T00:00:00.000Z" } }; } }) };
}

describe("versioned source plugins", () => {
	test("registers and verifies a versioned adapter against the shared source contract", async () => {
		const registry = new SourcePluginRegistry();
		registry.register(plugin("1"));
		expect(registry.list()).toEqual([{ id: "fixture", version: "1", kind: "test", trusted: true }]);
		await expect(registry.verify("fixture")).resolves.toEqual({ descriptor: { id: "fixture", version: "1", kind: "test", trusted: true }, documentCount: 1, externalIds: ["one"] });
	});

	test("requires unambiguous versions and explicit untrusted plugin opt-in", () => {
		const registry = new SourcePluginRegistry();
		registry.register(plugin("1"));
		registry.register(plugin("2"));
		expect(() => registry.resolve("fixture")).toThrow("version is required");
		expect(registry.resolve("fixture", "2").descriptor.version).toBe("2");
		expect(() => registry.register(plugin("3", false))).toThrow("explicit opt-in");
		expect(() => new SourcePluginRegistry({ allowUntrusted: true }).register(plugin("3", false))).not.toThrow();
	});

	test("enforces declared engine compatibility during registration", () => {
		const compatible = plugin("4");
		compatible.descriptor.compatibility = { minimumEngine: "1.2", maximumEngine: "2.0" };
		expect(() => new SourcePluginRegistry({ engineVersion: "1.9" }).register(compatible)).not.toThrow();
		const incompatible = plugin("5");
		incompatible.descriptor.compatibility = { minimumEngine: "3.0" };
		expect(() => new SourcePluginRegistry({ engineVersion: "2.9" }).register(incompatible)).toThrow("incompatible");
	});

	test("rejects plugins whose adapter identity diverges from its registration", async () => {
		await expect(verifySourcePlugin({ descriptor: { id: "fixture", version: "1", kind: "test", trusted: true }, create: () => ({ id: "other", describe: () => ({ id: "other", version: "1", kind: "test", trusted: true }), async *scan() {} }) })).rejects.toThrow("invalid adapter");
	});
});
