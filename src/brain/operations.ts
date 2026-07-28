type Repository = {
	head(): Promise<string | undefined>;
	getSettings(): Promise<unknown>;
	setSchemaPack(pack: { id: string; version: string }, expectedHead?: string): Promise<unknown>;
	listSchemaPacks(): Promise<unknown[]>;
	installSchemaPack(pack: { id: string; version: string; pathTypes: Record<string, string> }, expectedHead?: string): Promise<unknown>;
	getPage(path: string, includeDeleted?: boolean): Promise<unknown>;
	snapshot(ref?: string): Promise<{ brainId?: string; repositoryId?: string; commit?: string; settings?: unknown; pages: Array<{ id: string; path: string; deleted?: boolean }> }>;
	readPage(snapshot: { pages: Array<{ id: string; path: string }> }, id: string): Promise<unknown>;
	listPages(includeDeleted?: boolean): Promise<unknown[]>;
	reconcileManifest(expectedHead?: string): Promise<unknown>;
	pageHistory(path: string, limit?: number): Promise<unknown[]>;
	revertPage(path: string, ref: string, expectedRevision: string, expectedHead?: string): Promise<unknown>;
	putPage(path: string, content: string, expectedRevision?: string, source?: { type: string; externalId: string }, expectedHead?: string): Promise<unknown>;
	movePage(from: string, to: string, expectedRevision: string, expectedHead?: string): Promise<unknown>;
	deletePage(path: string, expectedRevision: string, expectedHead?: string): Promise<unknown>;
	restorePage(id: string, path: string, expectedRevision: string, expectedHead?: string): Promise<unknown>;
	purgeDeletedPage(id: string, expectedHead?: string, retentionDays?: number): Promise<unknown>;
	setPageAccessLabels(path: string, labels: string[], expectedRevision: string, expectedHead?: string): Promise<unknown>;
};

export type BrainRepositoryOperation = "brain_status" | "get_schema" | "list_schema_packs" | "install_schema_pack" | "set_schema_pack" | "get_page" | "get_page_at" | "export_brain" | "list_pages" | "repair_brain" | "page_history" | "revert_page" | "put_page" | "move_page" | "delete_page" | "restore_page" | "purge_deleted_page" | "set_page_access_labels";

export const brainRepositoryOperationNames: BrainRepositoryOperation[] = ["brain_status", "get_schema", "list_schema_packs", "install_schema_pack", "set_schema_pack", "get_page", "get_page_at", "export_brain", "list_pages", "repair_brain", "page_history", "revert_page", "put_page", "move_page", "delete_page", "restore_page", "purge_deleted_page", "set_page_access_labels"];

export const brainRepositoryOperationSchemas = [
	{ name: "brain_status", description: "Read repository head, settings, and page counts.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "get_schema", description: "Read the active schema pack selection.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "list_schema_packs", description: "List bundled and repository-installed schema packs.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "install_schema_pack", description: "Install an immutable custom schema pack through a repository-head compare-and-swap.", inputSchema: { type: "object", properties: { pack: { type: "object" }, expectedHead: { type: "string" } }, required: ["pack", "expectedHead"], additionalProperties: false } },
	{ name: "set_schema_pack", description: "Activate a schema pack through a repository-head compare-and-swap.", inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "string" }, expectedHead: { type: "string" } }, required: ["id", "version", "expectedHead"], additionalProperties: false } },
	{ name: "get_page", description: "Read one Markdown page from the configured brain repository.", inputSchema: { type: "object", properties: { path: { type: "string" }, includeDeleted: { type: "boolean" } }, required: ["path"], additionalProperties: false } },
	{ name: "get_page_at", description: "Read one page from an immutable Git snapshot.", inputSchema: { type: "object", properties: { path: { type: "string" }, ref: { type: "string" } }, required: ["path", "ref"], additionalProperties: false } },
	{ name: "export_brain", description: "Export pages and settings from one immutable Git snapshot.", inputSchema: { type: "object", properties: { ref: { type: "string" }, includeDeleted: { type: "boolean" } }, additionalProperties: false } },
	{ name: "list_pages", description: "List pages from the configured brain repository.", inputSchema: { type: "object", properties: { includeDeleted: { type: "boolean" } }, additionalProperties: false } },
	{ name: "repair_brain", description: "Reconcile safe manual Markdown changes into the manifest with a repository-head compare-and-swap.", inputSchema: { type: "object", properties: { expectedHead: { type: "string" } }, required: ["expectedHead"], additionalProperties: false } },
	{ name: "page_history", description: "Read immutable Git history for one brain page.", inputSchema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500 } }, required: ["path"], additionalProperties: false } },
	{ name: "revert_page", description: "Restore one page from immutable Git bytes.", inputSchema: { type: "object", properties: { path: { type: "string" }, ref: { type: "string" }, expectedRevision: { type: "string" }, expectedHead: { type: "string" } }, required: ["path", "ref", "expectedRevision", "expectedHead"], additionalProperties: false } },
	{ name: "put_page", description: "Create or update a brain page with a repository-head compare-and-swap; use null only to assert an empty repository.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, expectedRevision: { type: "string" }, expectedHead: { type: ["string", "null"] } }, required: ["path", "content", "expectedHead"], additionalProperties: false } },
	{ name: "move_page", description: "Move a brain page with optimistic concurrency control.", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, expectedRevision: { type: "string" }, expectedHead: { type: "string" } }, required: ["from", "to", "expectedRevision", "expectedHead"], additionalProperties: false } },
	{ name: "delete_page", description: "Recoverably move a brain page into protected trash.", inputSchema: { type: "object", properties: { path: { type: "string" }, expectedRevision: { type: "string" }, expectedHead: { type: "string" } }, required: ["path", "expectedRevision", "expectedHead"], additionalProperties: false } },
	{ name: "restore_page", description: "Restore a deleted brain page from protected trash.", inputSchema: { type: "object", properties: { id: { type: "string" }, path: { type: "string" }, expectedRevision: { type: "string" }, expectedHead: { type: "string" } }, required: ["id", "path", "expectedRevision", "expectedHead"], additionalProperties: false } },
	{ name: "purge_deleted_page", description: "Permanently purge one retention-expired deleted page.", inputSchema: { type: "object", properties: { id: { type: "string" }, expectedHead: { type: "string" }, retentionDays: { type: "integer", minimum: 1, maximum: 3650 } }, required: ["id", "expectedHead"], additionalProperties: false } },
	{ name: "set_page_access_labels", description: "Set durable logical access labels for one brain page.", inputSchema: { type: "object", properties: { path: { type: "string" }, labels: { type: "array", items: { type: "string" } }, expectedRevision: { type: "string" }, expectedHead: { type: "string" } }, required: ["path", "labels", "expectedRevision", "expectedHead"], additionalProperties: false } },
] as const;

function stringArgument(args: Record<string, unknown>, name: string): string {
	if (typeof args[name] !== "string" || !args[name]) throw new Error("invalid params");
	return args[name];
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
	if (args[name] === undefined) return undefined;
	if (typeof args[name] !== "string") throw new Error("invalid params");
	return args[name];
}

function schemaPackArgument(args: Record<string, unknown>): { id: string; version: string; pathTypes: Record<string, string> } {
	const pack = args.pack;
	if (!pack || typeof pack !== "object" || Array.isArray(pack)) throw new Error("invalid params");
	const value = pack as Record<string, unknown>;
	if (typeof value.id !== "string" || typeof value.version !== "string" || !value.pathTypes || typeof value.pathTypes !== "object" || Array.isArray(value.pathTypes) || Object.values(value.pathTypes).some((type) => typeof type !== "string")) throw new Error("invalid params");
	return { id: value.id, version: value.version, pathTypes: value.pathTypes as Record<string, string> };
}

function requiredHead(args: Record<string, unknown>): string {
	return stringArgument(args, "expectedHead");
}

async function headForCreate(args: Record<string, unknown>, repository: Repository): Promise<string | undefined> {
	if (args.expectedHead === null) {
		if (await repository.head() !== undefined) throw new Error("invalid params");
		return undefined;
	}
	return requiredHead(args);
}

function only(args: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("invalid params");
}

export function isBrainRepositoryOperation(name: string): name is BrainRepositoryOperation {
	return (brainRepositoryOperationNames as string[]).includes(name);
}

export async function executeBrainRepositoryOperation(repository: Repository, name: BrainRepositoryOperation, args: Record<string, unknown>): Promise<unknown> {
	if (name === "brain_status") {
		only(args, []);
		const pages = await repository.listPages(true) as Array<{ deleted?: boolean }>;
		return { head: await repository.head(), settings: await repository.getSettings(), pages: { active: pages.filter((page: { deleted?: boolean }) => !page.deleted).length, deleted: pages.filter((page: { deleted?: boolean }) => page.deleted).length } };
	}
	if (name === "get_schema") {
		only(args, []);
		return { schemaPack: (await repository.getSettings() as { schemaPack: unknown }).schemaPack };
	}
	if (name === "list_schema_packs") {
		only(args, []);
		return { packs: await repository.listSchemaPacks() };
	}
	if (name === "install_schema_pack") {
		only(args, ["pack", "expectedHead"]);
		return repository.installSchemaPack(schemaPackArgument(args), requiredHead(args));
	}
	if (name === "set_schema_pack") {
		only(args, ["id", "version", "expectedHead"]);
		return repository.setSchemaPack({ id: stringArgument(args, "id"), version: stringArgument(args, "version") }, requiredHead(args));
	}
	if (name === "get_page") {
		only(args, ["path", "includeDeleted"]);
		if (args.includeDeleted !== undefined && typeof args.includeDeleted !== "boolean") throw new Error("invalid params");
		const page = await repository.getPage(stringArgument(args, "path"), args.includeDeleted === true);
		if (!page) throw new Error("invalid params");
		return page;
	}
	if (name === "get_page_at") {
		only(args, ["path", "ref"]);
		const snapshot = await repository.snapshot(stringArgument(args, "ref"));
		const page = snapshot.pages.find((entry) => entry.path === stringArgument(args, "path"));
		if (!page) throw new Error("invalid params");
		return repository.readPage(snapshot, page.id);
	}
	if (name === "export_brain") {
		only(args, ["ref", "includeDeleted"]);
		if (args.includeDeleted !== undefined && typeof args.includeDeleted !== "boolean") throw new Error("invalid params");
		const snapshot = await repository.snapshot(optionalString(args, "ref"));
		const pages = await Promise.all(snapshot.pages.filter((page) => args.includeDeleted === true || !page.deleted).map(async (page) => repository.readPage(snapshot, page.id)));
		return { brainId: snapshot.brainId, repositoryId: snapshot.repositoryId, commit: snapshot.commit, settings: snapshot.settings, pages };
	}
	if (name === "list_pages") {
		only(args, ["includeDeleted"]);
		if (args.includeDeleted !== undefined && typeof args.includeDeleted !== "boolean") throw new Error("invalid params");
		return { pages: await repository.listPages(args.includeDeleted === true) };
	}
	if (name === "repair_brain") {
		only(args, ["expectedHead"]);
		return repository.reconcileManifest(requiredHead(args));
	}
	if (name === "page_history") {
		only(args, ["path", "limit"]);
		if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500)) throw new Error("invalid params");
		return { history: await repository.pageHistory(stringArgument(args, "path"), args.limit as number | undefined) };
	}
	if (name === "revert_page") {
		only(args, ["path", "ref", "expectedRevision", "expectedHead"]);
		return repository.revertPage(stringArgument(args, "path"), stringArgument(args, "ref"), stringArgument(args, "expectedRevision"), requiredHead(args));
	}
	if (name === "put_page") {
		only(args, ["path", "content", "expectedRevision", "expectedHead"]);
		return repository.putPage(stringArgument(args, "path"), stringArgument(args, "content"), optionalString(args, "expectedRevision"), undefined, await headForCreate(args, repository));
	}
	if (name === "move_page") {
		only(args, ["from", "to", "expectedRevision", "expectedHead"]);
		return repository.movePage(stringArgument(args, "from"), stringArgument(args, "to"), stringArgument(args, "expectedRevision"), requiredHead(args));
	}
	if (name === "delete_page") {
		only(args, ["path", "expectedRevision", "expectedHead"]);
		return repository.deletePage(stringArgument(args, "path"), stringArgument(args, "expectedRevision"), requiredHead(args));
	}
	if (name === "purge_deleted_page") {
		only(args, ["id", "expectedHead", "retentionDays"]);
		if (args.retentionDays !== undefined && (typeof args.retentionDays !== "number" || !Number.isInteger(args.retentionDays))) throw new Error("invalid params");
		return repository.purgeDeletedPage(stringArgument(args, "id"), requiredHead(args), args.retentionDays as number | undefined);
	}
	if (name === "set_page_access_labels") {
		only(args, ["path", "labels", "expectedRevision", "expectedHead"]);
		if (!Array.isArray(args.labels) || args.labels.some((label) => typeof label !== "string")) throw new Error("invalid params");
		return repository.setPageAccessLabels(stringArgument(args, "path"), args.labels, stringArgument(args, "expectedRevision"), requiredHead(args));
	}
	only(args, ["id", "path", "expectedRevision", "expectedHead"]);
	return repository.restorePage(stringArgument(args, "id"), stringArgument(args, "path"), stringArgument(args, "expectedRevision"), requiredHead(args));
}
