import { describe, expect, test } from "bun:test";
import { setupSourceRegistry } from "@manas/setup-sources";

describe("setup source registry", () => {
	test("distinguishes local detection from export-only sources", () => {
		const sources = setupSourceRegistry();
		expect(sources.find((source) => source.id === "chatgpt")).toMatchObject({ kind: "export", detectable: false });
		expect(sources.find((source) => source.id === "claude")?.instructions).toContain("manas import claude");
		expect(sources.filter((source) => source.kind === "local")).toHaveLength(5);
	});
});
