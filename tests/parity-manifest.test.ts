import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	ParityManifestError,
	validateParityManifest,
	verifyParityManifest,
} from "../src/parity/verify";

const rootDir = process.cwd();
const manifestPath = join(rootDir, "docs", "parity-manifest.json");

async function loadManifest(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
}

async function expectInvalid(manifest: Record<string, unknown>, text: string): Promise<void> {
	try {
		await validateParityManifest(manifest, { rootDir, manifestPath: "docs/parity-manifest.json" });
		throw new Error("expected manifest validation to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(ParityManifestError);
		expect((error as ParityManifestError).message).toContain(text);
	}
}

describe("parity manifest verification", () => {
	test("validates the current manifest and reports exact status counts", async () => {
		const report = await verifyParityManifest("docs/parity-manifest.json", { rootDir });
		expect(report.valid).toBe(true);
		expect(report.capabilityCount).toBe(27);
		expect(report.counts).toEqual({ missing: 0, partial: 0, implemented: 0, verified: 27 });
		expect(report.remaining).toHaveLength(0);
		expect(report.verified).toContain("skills-agent-integrations");
	});

	test("rejects an unknown capability status", async () => {
		const manifest = await loadManifest();
		const capabilities = manifest.capabilities as Array<Record<string, unknown>>;
		capabilities[0] = { ...capabilities[0], status: "complete" };
		await expectInvalid(manifest, "unknown status");
	});

	test("requires acceptance tests for verified capabilities", async () => {
		const manifest = await loadManifest();
		const capabilities = manifest.capabilities as Array<Record<string, unknown>>;
		capabilities[0] = { ...capabilities[0], status: "verified", acceptance: [] };
		await expectInvalid(manifest, "verified capability lacks acceptance tests");
	});

	test("release verification accepts the complete manifest", async () => {
		await expect(verifyParityManifest("docs/parity-manifest.json", { rootDir, requireVerified: true })).resolves.toMatchObject({ capabilityCount: 27, counts: { verified: 27 } });
	});

	test("rejects missing acceptance-test paths", async () => {
		const manifest = await loadManifest();
		const capabilities = manifest.capabilities as Array<Record<string, unknown>>;
		capabilities[0] = { ...capabilities[0], acceptance: ["tests/does-not-exist.test.ts"] };
		await expectInvalid(manifest, "acceptance-test path does not exist");
	});

	test("rejects duplicate capability IDs", async () => {
		const manifest = await loadManifest();
		const capabilities = manifest.capabilities as Array<Record<string, unknown>>;
		manifest.capabilities = [...capabilities, { ...capabilities[0] }];
		await expectInvalid(manifest, "duplicate capability ID");
	});

	test("rejects manifests missing a required category", async () => {
		const manifest = await loadManifest();
		manifest.categories = (manifest.categories as string[]).filter((category) => category !== "advanced");
		await expectInvalid(manifest, "required category is absent: advanced");
	});
});
