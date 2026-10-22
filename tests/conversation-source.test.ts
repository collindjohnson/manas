import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "sources", "conversations"].join(String.fromCharCode(47));
const { ConversationSourceAdapter } = await import(modulePath);

describe("conversation source adapter", () => {
	test("adapts existing coding-agent conversations to stable source documents", async () => {
		const adapter = new ConversationSourceAdapter("codex", async () => [{
			provider: "codex",
			sourceId: "session-1",
			sourcePath: "session.jsonl",
			project: "brain",
			messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "world" }],
		}]);
		const [document] = await adapter.list();
		expect(document).toMatchObject({ externalId: "session-1", suggestedPath: ["conversations", "codex", "session-1.md"].join(String.fromCharCode(47)), deleted: false });
		expect(document.content).toContain("user: hello");
		expect(document.contentHash).toHaveLength(64);
		expect(document.externalRevision).toBeUndefined();
		expect(document.provenance.metadata).toEqual({ project: "brain" });
		expect(adapter.describe()).toMatchObject({ id: "codex", kind: "conversation", version: "1" });
		expect(adapter.checkpoint().updatedAt).toBeString();
	});
});

test("session cursors reconcile late records and same-timestamp edits without repeat delivery", async () => {
 const records = [{ provider: "codex", sourceId: "first", sourcePath: "first.jsonl", updatedAt: "2024-01-01T00:00:00Z", messages: [{ role: "user" as const, text: "original" }] }];
 const adapter = new ConversationSourceAdapter("codex", async () => records);
 expect(await Array.fromAsync(adapter.scan({ updatedAt: "2026-01-01T00:00:00Z" }))).toHaveLength(1);
 const checkpoint = adapter.checkpoint();
 expect(await Array.fromAsync(adapter.scan(checkpoint))).toEqual([]);
 records.push({ ...records[0]!, sourceId: "late" });
 records[0]!.messages[0]!.text = "edited";
 expect((await Array.fromAsync(adapter.scan(checkpoint))).map((document) => (document as { externalId: string }).externalId)).toEqual(["first", "late"]);
 expect(await Array.fromAsync(adapter.scan(adapter.checkpoint()))).toEqual([]);
});
