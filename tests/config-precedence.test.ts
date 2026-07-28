import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "config-precedence"].join(String.fromCharCode(47));
const { resolveConfiguration, resolveSetting } = await import(modulePath);

describe("configuration precedence", () => {
	test("merges nested settings with explicit values winning over environment, file, and defaults", () => {
		expect(resolveConfiguration({ defaults: { mode: "local", brain: { endpoint: "default", model: "base" } }, file: { mode: "file", brain: { model: "file" } }, environment: { mode: "environment", brain: { endpoint: "env" } }, explicit: { mode: "explicit" } })).toEqual({ mode: "explicit", brain: { endpoint: "env", model: "file" } });
	});

	test("reports the winning source and never treats undefined as an override", () => {
		expect(resolveSetting([{ source: "default", value: "a" }, { source: "environment", value: undefined }, { source: "explicit", value: "c" }])).toEqual({ source: "explicit", value: "c" });
		expect(resolveSetting([{ source: "default", value: undefined }, { source: "file", value: undefined }])).toBeUndefined();
	});
});
