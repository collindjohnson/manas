import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { assertBrainIdentity, assertBrainManifestEntry, BrainMetadataError } from "../src/brain/metadata";
import { BrainRepository } from "../src/brain/repository";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<BrainRepository> {
	const root = await mkdtemp(join(tmpdir(), "chat-history-repository-metadata-"));
	roots.push(root);
	const brain = new BrainRepository(join(root, "brain"));
	await brain.initialize();
	await execFile("git", ["-C", brain.root, "config", "user.name", "Test User"]);
	await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
	return brain;
}

describe("authoritative repository metadata", () => {
	test("commits durable ownership, tombstone, remote, and protected-branch policy", async () => {
		const brain = await fixture();
		const identity = await brain.getIdentity();
		expect(identity).toMatchObject({
			metadataVersion: 1,
			generatedContentOwner: "manas",
			managedSectionOwner: "source-adapters",
			tombstonePolicy: { mode: "recoverable-trash", deletionTimestampField: "deletedAt" },
			canonicalRemote: null,
			protectedBranchPolicy: { requireExpectedHead: true, allowForcePush: false, pushMode: "explicit" },
		});
		expect(identity.brainId).toMatch(/^[0-9a-f-]{36}$/i);
		expect(identity.repositoryId).toMatch(/^[0-9a-f-]{36}$/i);
		const remote = await brain.setCanonicalRemote({ name: "origin", url: "file:///tmp/brain-remote.git", branch: "main", fetchMode: "explicit", pushMode: "explicit" });
		expect(remote.identity.canonicalRemote).toEqual({ name: "origin", url: "file:///tmp/brain-remote.git", branch: "main", fetchMode: "explicit", pushMode: "explicit" });
		const page = await brain.putPage("notes/source.md", "body", undefined, { type: "fixture", externalId: "source-1", externalRevision: "r1", updatedAt: "2026-07-27T00:00:00.000Z" });
		const body = (await execFile("git", ["-C", brain.root, "show", "-s", "--format=%B", page.commit])).stdout;
		expect(body).toContain("Brain-Actor: manas");
		expect(body).toContain("Brain-Operation: put");
		expect(body).toContain("Brain-Source-Type: fixture");
		expect(body).toContain("Brain-Source-ID: source-1");
		expect(body).toContain("Brain-Source-Revision: r1");
		expect((await brain.snapshot(page.commit)).pages[0]?.source).toMatchObject({ type: "fixture", externalId: "source-1" });
		expect((await brain.snapshot(page.commit)).canonicalRemote).toEqual(remote.identity.canonicalRemote);
	});

	test("rejects tampered working-tree identity metadata", async () => {
		const brain = await fixture();
		const identityPath = join(brain.root, ".brain", "identity.json");
		const identity = JSON.parse(await readFile(identityPath, "utf8")) as Record<string, unknown>;
		identity.metadataVersion = 99;
		await writeFile(identityPath, JSON.stringify(identity));
		await expect(brain.getIdentity()).rejects.toBeInstanceOf(BrainMetadataError);
	});

	test("strictly validates manifest entries and rejects credential-bearing remotes", async () => {
		const brain = await fixture();
		const identity = await brain.getIdentity();
		expect(() => assertBrainIdentity({ ...identity, unexpected: true })).toThrow("not recognized");
		expect(() => assertBrainIdentity({ ...identity, canonicalRemote: { name: "origin", url: "https://user:password@example.invalid/brain.git", branch: "main", fetchMode: "explicit", pushMode: "explicit" } })).toThrow("credentials");
		expect(() => assertBrainManifestEntry({ id: "page", path: "../outside.md", contentHash: "hash", revision: "revision" })).toThrow("normalized");
		expect(() => assertBrainManifestEntry({ id: "page", path: "notes/page.md", contentHash: "hash", revision: "revision", unknown: true })).toThrow("not recognized");
		expect(() => assertBrainManifestEntry({ id: "page", path: ".brain/trash/page.md", contentHash: "hash", revision: "revision", deleted: false })).toThrow("normalized");

		const manifestPath = join(brain.root, ".brain", "manifest.jsonl");
		const original = await readFile(manifestPath, "utf8");
		await writeFile(manifestPath, JSON.stringify({ id: "page", path: "notes/page.md", contentHash: "hash", revision: "revision", unknown: true }) + "\n");
		await expect(brain.listPages()).rejects.toBeInstanceOf(BrainMetadataError);
		await writeFile(manifestPath, original);
	});
});
