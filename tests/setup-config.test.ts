import { describe, expect, test } from "bun:test";
import { normalizeSetupConfiguration, SETUP_CONFIG_VERSION } from "@manas/setup-config";

const slash = String.fromCharCode(47);
const root = slash + "tmp" + slash + "manas";
const valid = { archiveRoot: root + slash + "archive", stateRoot: root + slash + "state", launchAgentPath: root + slash + "agent.plist" };

describe("setup configuration", () => {
	test("normalizes a compatible legacy configuration", () => {
		expect(normalizeSetupConfiguration(valid)).toEqual({ configVersion: SETUP_CONFIG_VERSION, ...valid });
	});

	test("rejects unsafe paths and unsupported versions", () => {
		expect(() => normalizeSetupConfiguration({ ...valid, archiveRoot: "archive" })).toThrow("absolute");
		expect(() => normalizeSetupConfiguration({ ...valid, stateRoot: valid.archiveRoot })).toThrow("must not overlap");
		expect(() => normalizeSetupConfiguration({ ...valid, configVersion: 2 })).toThrow("unsupported");
	});
});
