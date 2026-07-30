import { describe, expect, test } from "bun:test";
import { renderLaunchAgent } from "@manas/launch-agent";

const slash = String.fromCharCode(47);
const root = slash + "tmp" + slash;
const config = { archiveRoot: root + "archive", stateRoot: root + "state", launchAgentPath: root + "agent.plist" };

describe("LaunchAgent target validation", () => {
	test("renders an explicit installed binary and configuration", () => {
		const plist = renderLaunchAgent(config, { installedBinary: root + "bin" + slash + "manas", configPath: root + "config.json" });
		expect(plist).toContain(root + "bin" + slash + "manas");
		expect(plist).toContain(root + "config.json");
		expect(plist).toContain("--scheduled");
		expect(plist).not.toContain("<string><" + String.fromCharCode(47) + "string>");
	});

	test("rejects relative and dependency paths", () => {
		expect(() => renderLaunchAgent(config, root + "legacy-config.json")).toThrow("explicit installed binary");
		expect(() => renderLaunchAgent(config, { installedBinary: "manas", configPath: root + "config.json" })).toThrow("absolute");
		expect(() => renderLaunchAgent(config, { installedBinary: root + "node_modules" + slash + "manas", configPath: root + "config.json" })).toThrow("must not reference");
	});
});
