import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationSourceAdapter } from "../src/sources/conversations";
import { LinkedRepositorySourceAdapter } from "../src/sources/linked-repository";
import { verifySourceAdapterConformance } from "../src/sources/conformance";

const modulePath = ["..", "src", "sources", "conformance"].join(String.fromCharCode(47));
const { assertNormalizedDocuments, assertSourceDescriptor } = await import(modulePath);

describe("source conformance", () => {
	test("accepts complete normalized documents", () => {
		expect(() => assertSourceDescriptor({ id: "fixture", version: "1", kind: "test", trusted: true })).not.toThrow();
		expect(() => assertNormalizedDocuments("fixture", [{ externalId: "one", suggestedPath: "files/one.md", content: "body", deleted: false, provenance: { sourceType: "fixture", retrievedAt: "2026-07-24T00:00:00.000Z" } }])).not.toThrow();
	});

	test("rejects duplicate identities, traversal, and missing provenance", () => {
		const document = { externalId: "one", suggestedPath: "files/one.md", content: "body", deleted: false, provenance: { sourceType: "fixture", retrievedAt: "2026-07-24T00:00:00.000Z" } };
		expect(() => assertNormalizedDocuments("fixture", [document, document])).toThrow("unique external IDs");
		expect(() => assertNormalizedDocuments("fixture", [{ ...document, suggestedPath: `files${String.fromCharCode(47)}..${String.fromCharCode(47)}escape.md` }])).toThrow("unsafe suggested path");
		expect(() => assertNormalizedDocuments("fixture", [{ ...document, provenance: { sourceType: "", retrievedAt: "invalid" } }])).toThrow("valid provenance");
		expect(() => assertNormalizedDocuments("fixture", [{ ...document, contentHash: "0".repeat(64) }])).toThrow("content hash");
	});

	test("runs the same deterministic public gate for built-in adapters", async () => {
		const conversation = await verifySourceAdapterConformance(() => new ConversationSourceAdapter("fixture", async () => [{ provider: "fixture", sourceId: "one", sourcePath: "one.json", messages: [{ role: "user", text: "hello" }] }]));
		expect(conversation).toMatchObject({ descriptor: { id: "fixture", kind: "conversation" }, deterministic: true, documents: [{ externalId: "one" }] });
	});

	test("runs the gate for a linked repository without copying its source files", async () => {
		const root = await mkdtemp(join(tmpdir(), "source-conformance-"));
		try {
			await Bun.$`git -C ${root} init`;
			await Bun.$`git -C ${root} config user.name Test`;
			await Bun.$`git -C ${root} config user.email test@example.invalid`;
			await writeFile(join(root, "note.md"), "linked");
			await Bun.$`git -C ${root} add note.md`;
			await Bun.$`git -C ${root} commit -m initial`;
			const result = await verifySourceAdapterConformance(() => new LinkedRepositorySourceAdapter(root));
			expect(result).toMatchObject({ descriptor: { kind: "linked-repository" }, deterministic: true });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
