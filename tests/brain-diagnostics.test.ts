import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "diagnostics"].join(String.fromCharCode(47));
const { diagnoseBrain } = await import(modulePath);

describe("brain diagnostics", () => {
	test("reports repository integrity and stale projection state without document content", async () => {
		const repository = {
			head: async () => "head",
			verify: async () => ({ valid: true, issues: [], commit: "head" }),
			snapshot: async () => ({ brainId: "brain" }),
			getSettings: async () => ({ schemaPack: { id: "default", version: "1" }, sources: { files: {} } }),
			listPages: async () => [{}, { deleted: true }],
		};
		const store = { query: async (sql: string) => sql.includes("projection_runs") ? [{ git_commit: "old", status: "complete" }] : [{ status: "pending", count: "2" }] };
		await expect(diagnoseBrain(repository, store)).resolves.toMatchObject({ ok: false, repository: { pages: { active: 1, deleted: 1 }, sources: 1 }, projection: { current: false, jobs: { pending: 2 } }, warnings: ["projection is stale or incomplete; run brain index or a queued index job"] });
	});

	test("explains an initialized but uncommitted repository", async () => {
		const repository = { head: async () => undefined, getSettings: async () => ({ schemaPack: { id: "default", version: "1" }, sources: {} }), listPages: async () => [] };
		await expect(diagnoseBrain(repository as never)).resolves.toMatchObject({ ok: false, warnings: ["repository has no committed snapshot"] });
	});
});
