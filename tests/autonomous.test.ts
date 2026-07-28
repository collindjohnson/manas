import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "autonomous"].join(String.fromCharCode(47));
const { AgentRunStore } = await import(modulePath);

describe("autonomous operation guard", () => {
	test("persists intent, confines proposals, and revalidates the Git head", () => {
		const store = new AgentRunStore();
		const intent = store.create({ agent: "maintenance", operation: "repair-links", baseCommit: "abc", policy: { authority: "write", dryRun: false, ownedPaths: ["notes"], managedSections: ["links"], protectedPaths: [".brain"] } });
		expect(store.begin(intent.id).status).toBe("executing");
		const proposal = store.propose({ runId: intent.id, paths: ["notes/page.md"], changes: [{ path: "notes/page.md", content: "updated", managedSection: "links" }], cost: 1, createdAt: new Date().toISOString() });
		expect(proposal.status).toBe("proposed");
		expect(() => store.commit(intent.id, "different")).toThrow("stale");
		const receipt = store.commit(intent.id, "abc");
		expect(receipt).toMatchObject({ status: "committed", result: { dryRun: false } });
	});

	test("requires write authority, budgets cost, and rejects path or section escapes", () => {
		const store = new AgentRunStore();
		expect(() => store.create({ agent: "agent", operation: "write", baseCommit: "abc", policy: { authority: "read", dryRun: false, ownedPaths: ["notes"] } })).toThrow("write authority");
		const dryRun = store.create({ agent: "agent", operation: "preview", baseCommit: "abc", policy: { authority: "read", dryRun: true, ownedPaths: ["notes"], maxCost: 2 } });
		store.begin(dryRun.id);
		expect(() => store.propose({ runId: dryRun.id, paths: ["notes/x.md"], changes: [{ path: "../secrets.txt", content: "no" }], cost: 1, createdAt: new Date().toISOString() })).toThrow("outside");
		expect(() => store.propose({ runId: dryRun.id, paths: ["notes/x.md"], changes: [{ path: "notes/x.md", content: "no", managedSection: "body" }], cost: 3, createdAt: new Date().toISOString() })).toThrow("budget");
	});
});
