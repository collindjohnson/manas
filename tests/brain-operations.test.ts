import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "operations"].join(String.fromCharCode(47));
const { brainRepositoryOperationNames, brainRepositoryOperationSchemas, executeBrainRepositoryOperation } = await import(modulePath);

describe("brain operation registry", () => {
	test("declares one schema for every executable repository operation", () => {
		expect(brainRepositoryOperationSchemas.map((operation: { name: string }) => operation.name)).toEqual(brainRepositoryOperationNames);
	});

	test("validates and executes page writes through the shared operation", async () => {
		const calls: unknown[][] = [];
		const repository = {
			head: async () => "head",
		getSettings: async () => ({ schemaPack: { id: "default", version: "1" } }),
		setSchemaPack: async (pack: { id: string; version: string }) => ({ settings: { schemaPack: pack } }),
		listSchemaPacks: async () => [{ id: "default", version: "1", pathTypes: {} }],
		installSchemaPack: async (pack: { id: string; version: string; pathTypes: Record<string, string> }) => ({ pack }),
			getPage: async () => undefined,
		snapshot: async () => ({ brainId: "brain", repositoryId: "repo", commit: "abc", settings: { schemaPack: { id: "default", version: "1" } }, pages: [{ id: "one", path: "notes/a.md" }, { id: "deleted", path: "notes/deleted.md", deleted: true }] }),
			readPage: async () => ({ content: "historic" }),
		listPages: async () => [],
		reconcileManifest: async () => ({ created: 0, renamed: 0, warnings: [] }),
			pageHistory: async () => [],
			revertPage: async (...args: unknown[]) => { calls.push(args); return { operation: "revert" }; },
			putPage: async (...args: unknown[]) => { calls.push(args); return { operation: "put" }; },
			movePage: async () => ({ operation: "move" }),
			deletePage: async () => ({ operation: "delete" }),
		restorePage: async () => ({ operation: "restore" }),
		purgeDeletedPage: async () => ({ operation: "purge" }),
			setPageAccessLabels: async () => ({ operation: "access" }),
		};
		await expect(executeBrainRepositoryOperation(repository, "put_page", { path: "notes/a.md", content: "body", expectedHead: "head" })).resolves.toEqual({ operation: "put" });
		expect(calls).toEqual([["notes/a.md", "body", undefined, undefined, "head"]]);
		await expect(executeBrainRepositoryOperation(repository, "put_page", { path: "notes/a.md", content: "body", expectedHead: null })).rejects.toThrow("invalid params");
		await expect(executeBrainRepositoryOperation(repository, "brain_status", {})).resolves.toMatchObject({ head: "head", pages: { active: 0, deleted: 0 } });
		await expect(executeBrainRepositoryOperation(repository, "set_schema_pack", { id: "personal", version: "2", expectedHead: "head" })).resolves.toMatchObject({ settings: { schemaPack: { id: "personal", version: "2" } } });
		await expect(executeBrainRepositoryOperation(repository, "list_schema_packs", {})).resolves.toEqual({ packs: [{ id: "default", version: "1", pathTypes: {} }] });
		await expect(executeBrainRepositoryOperation(repository, "install_schema_pack", { pack: { id: "personal", version: "2", pathTypes: { "journal/": "entry" } }, expectedHead: "head" })).resolves.toEqual({ pack: { id: "personal", version: "2", pathTypes: { "journal/": "entry" } } });
		await expect(executeBrainRepositoryOperation(repository, "get_page_at", { path: "notes/a.md", ref: "abc" })).resolves.toEqual({ content: "historic" });
		await expect(executeBrainRepositoryOperation(repository, "repair_brain", { expectedHead: "head" })).resolves.toEqual({ created: 0, renamed: 0, warnings: [] });
		await expect(executeBrainRepositoryOperation(repository, "export_brain", { ref: "abc" })).resolves.toEqual({ brainId: "brain", repositoryId: "repo", commit: "abc", settings: { schemaPack: { id: "default", version: "1" } }, pages: [{ content: "historic" }] });
		await expect(executeBrainRepositoryOperation(repository, "put_page", { path: "notes/a.md", content: "body" })).rejects.toThrow("invalid params");
		await expect(executeBrainRepositoryOperation(repository, "put_page", { path: "notes/a.md", content: "body", extra: true })).rejects.toThrow("invalid params");
	});

	test("allows null HEAD only when creating the first repository commit", async () => {
		const calls: unknown[][] = [];
		const repository = {
			head: async () => undefined,
			putPage: async (...args: unknown[]) => { calls.push(args); return { operation: "put" }; },
		};
		await expect(executeBrainRepositoryOperation(repository as never, "put_page", { path: "notes/a.md", content: "body", expectedHead: null })).resolves.toEqual({ operation: "put" });
		expect(calls).toEqual([["notes/a.md", "body", undefined, undefined, undefined]]);
	});
});
