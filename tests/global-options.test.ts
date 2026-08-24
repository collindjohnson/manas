import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "global-options"].join(String.fromCharCode(47));
const { parseGlobalArguments } = await import(modulePath);

describe("global CLI options", () => {
	test("extracts config anywhere and preserves other arguments", () => {
		expect(parseGlobalArguments(["--config", "a.json", "health"])).toEqual({ args: ["health"], configPath: "a.json" });
		expect(parseGlobalArguments(["search", "query", "--semantic-only", "--config", "b.json"])).toEqual({
			args: ["search", "query", "--semantic-only"],
			configPath: "b.json",
		});
		expect(parseGlobalArguments(["health", "--unknown"])).toEqual({ args: ["health", "--unknown"] });
	});

	test("rejects duplicate and malformed config options", () => {
		expect(() => parseGlobalArguments(["health", "--config", "a", "--config", "b"])).toThrow("duplicate");
		expect(() => parseGlobalArguments(["health", "--config"])).toThrow("missing value");
		expect(() => parseGlobalArguments(["health", "--config", "--json"])).toThrow("missing value");
		expect(() => parseGlobalArguments(["health", "--config=a"])).toThrow("use --config <path>");
	});
});
