import { describe, expect, test } from "bun:test";
import { selectArchiveCandidate } from "@manas/setup-archive";

const root = String.fromCharCode(47);

describe("setup archive candidates", () => {
	test("prefers an explicit archive, then a compatible configured archive, then the default", () => {
		expect(selectArchiveCandidate(root + "chosen", root + "configured", root + "default")).toMatchObject({ path: root + "chosen", origin: "explicit" });
		expect(selectArchiveCandidate(undefined, root + "configured", root + "default")).toMatchObject({ path: root + "configured", origin: "configured" });
		expect(selectArchiveCandidate(undefined, undefined, root + "default")).toMatchObject({ path: root + "default", origin: "default" });
	});
});
