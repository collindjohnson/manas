import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrainDatabase, assertBrainIntegrity } from "../src/brain/database";
import {
	cosineSimilarity,
	deserializeVector,
	normalizeVector,
	serializeVector,
} from "../src/brain/vector";
import { indexArchive } from "../src/brain/indexer";
import { canonicalRemotePayload } from "../src/brain/payload";
import type { Config } from "../src/config";

const roots: string[] = [];
const schemaModule = ["..", "src", "brain", "schema"].join(String.fromCharCode(47));
	const { DEFAULT_SCHEMA_PACK, LEGACY_SCHEMA_PACK, assertSchemaActivationPreservesBytes, assertSchemaPack, detectSchemaPack, inferSchemaType, planSchemaUpgrade } = await import(schemaModule);
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture(): Promise<{ root: string; config: Config }> {
	const root = await mkdtemp(join(tmpdir(), "chat-history-brain-"));
	roots.push(root);
	const archive = join(root, "vault");
	const state = join(root, "state");
	await writeFile(join(root, "placeholder"), "");
	const config: Config = {
		archiveRoot: archive,
		stateRoot: state,
		launchAgentPath: join(root, "agent.plist"),
		brain: {
			databasePath: join(state, "brain.sqlite"),
			zeroEntropyBaseUrl: "http://127.0.0.1:1/v1",
			zeroEntropyCollection: "fixture",
			zeroEntropyBatchSize: 32,
			chunkTargetChars: 20,
			chunkMaxChars: 50,
			retrievalLimit: 20,
			synthesisEvidenceLimit: 8,
			requestTimeoutMs: 1000,
			codexTimeoutMs: 1000,
			synthesisCommand: "codex",
			keychainService: "fixture",
			keychainAccount: "fixture",
		},
	};
	await Bun.write(
		join(archive, "codex", "chat.md"),
		`---\nmanas_id: "N-1"\nprovider: "codex"\ntitle: "Example"\nsource_id: "source-1"\n---\n\nuser: hello world\n\nassistant: hello back\n`,
	);
	return { root, config };
}

describe("brain foundation", () => {
	test("infers schema types from paths without frontmatter", () => {
		expect(inferSchemaType("people" + String.fromCharCode(47) + "alice.md")).toBe("person");
		expect(inferSchemaType("notes" + String.fromCharCode(47) + "plain.md", DEFAULT_SCHEMA_PACK)).toBe("note");
		expect(inferSchemaType("unknown" + String.fromCharCode(47) + "file.md")).toBeUndefined();
		expect(() => inferSchemaType(".." + String.fromCharCode(47) + "secret.md")).toThrow("invalid schema path");
	});

	test("validates bundled schema packs and detects the best matching taxonomy", () => {
		expect(assertSchemaPack(LEGACY_SCHEMA_PACK)).toEqual(LEGACY_SCHEMA_PACK);
		expect(detectSchemaPack(["contacts/alice.md", "companies/acme.md", "ideas/roadmap.md"])).toEqual([{ pack: LEGACY_SCHEMA_PACK, matchedPaths: 3, score: 3 }]);
		expect(() => assertSchemaPack({ id: "bad value", version: "1", pathTypes: {} })).toThrow("invalid schema pack");
	});

	test("plans schema upgrades without changing page bytes implicitly", () => {
		const next = { ...DEFAULT_SCHEMA_PACK, version: "2", pathTypes: { ...DEFAULT_SCHEMA_PACK.pathTypes, "projects/": "project" } };
		const plan = planSchemaUpgrade(DEFAULT_SCHEMA_PACK, next);
		expect(plan).toMatchObject({ added: ["projects/"], removed: [], changed: [], compatible: true, requiresMigration: false });
		expect(() => assertSchemaActivationPreservesBytes(plan)).not.toThrow();
		const incompatible = planSchemaUpgrade(DEFAULT_SCHEMA_PACK, { ...next, pathTypes: { ...next.pathTypes, "notes/": "project" } });
		expect(() => assertSchemaActivationPreservesBytes(incompatible)).toThrow("approved migration");
	});

	test("serializes normalized vectors and calculates cosine similarity", () => {
		const vector = normalizeVector([3, 4]);
		expect(deserializeVector(serializeVector(vector), 2)).toEqual(vector);
		expect(cosineSimilarity(vector, vector)).toBeCloseTo(1);
	});

	test("uses the real source path in canonical remote metadata", () => {
		const payload = canonicalRemotePayload({
			id: "chunk",
			text: "text",
			contextualPrefix: "context",
			documentId: "N-1",
			provider: "codex",
			relativePath: "codex/chat.md",
			sourcePath: "/work/chat.jsonl",
			startOffset: 0,
			endOffset: 4,
		});
		expect(payload.metadata).toMatchObject({
			relative_path: "codex/chat.md",
			source_path: "/work/chat.jsonl",
		});
	});

	test("creates an integrity-checked disposable index and skips unchanged content", async () => {
		const { config } = await fixture();
		const first = await indexArchive(config);
		expect(first).toMatchObject({ scanned: 1, indexed: 1 });
		const second = await indexArchive(config);
		expect(second).toMatchObject({ scanned: 1, skipped: 1 });
		const database = await openBrainDatabase(config.brain!.databasePath);
		try {
			expect(() => assertBrainIntegrity(database)).not.toThrow();
		} finally {
			database.close();
		}
	});
});
