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
