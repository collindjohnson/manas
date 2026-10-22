import { isPrimaryEvidence } from "./evidence-contract";
import { memoryIsActive, MEMORY_SOURCE, MemoryOperationError } from "./memory";
import { brainRepositoryOperationNames, brainRepositoryOperationSchemas, executeBrainRepositoryOperation, type BrainRepositoryOperation } from "./operations";

export type OperationScope = "read" | "write" | "admin";
export type TrustBoundary = "remote-safe" | "local-only" | "confined-upload";
export type JsonSchema = Record<string, unknown>;

export type OperationAuthorization = { allowedAccessLabels?: string[] };
export type OperationAuthorizer = (definition: OperationDefinition, input: Record<string, unknown>) => void | OperationAuthorization | Promise<void | OperationAuthorization>;

export interface OperationContext {
	tenantId?: string;
	brainId?: string;
	principal?: string;
	userId?: string;
	allowedAccessLabels?: string[];
	scope: OperationScope;
	authorize?: OperationAuthorizer;
	signal?: AbortSignal;
}

export interface OperationDefinition<Input = unknown, Output = unknown> {
	name: string;
	description: string;
	inputSchema: JsonSchema;
	outputSchema: JsonSchema;
	requiredScope: OperationScope;
	trustBoundary: TrustBoundary;
	execute(context: OperationContext, input: Input): Promise<Output>;
}

function assertObjectInput(input: unknown): asserts input is Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("operation input must be an object");
}

function matchesType(value: unknown, type: unknown): boolean {
	if (Array.isArray(type)) return type.some((candidate) => matchesType(value, candidate));
	if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
	if (type === "array") return Array.isArray(value);
	if (type === "string") return typeof value === "string";
	if (type === "integer") return typeof value === "number" && Number.isInteger(value);
	if (type === "number") return typeof value === "number" && Number.isFinite(value);
	if (type === "boolean") return typeof value === "boolean";
	if (type === "null") return value === null;
	return true;
}

function validateSchema(schema: JsonSchema, input: Record<string, unknown>): void {
	if (!matchesType(input, schema.type ?? "object")) throw new Error("operation input has the wrong type");
	const required = schema.required;
	if (Array.isArray(required) && required.some((name) => typeof name !== "string" || !(name in input))) throw new Error("operation input is missing a required field");
	const properties = schema.properties;
	if (schema.additionalProperties === false && properties && typeof properties === "object" && !Array.isArray(properties)) {
		const allowed = new Set(Object.keys(properties));
		if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("operation input contains an unknown field");
	}
	if (properties && typeof properties === "object" && !Array.isArray(properties)) {
		for (const [name, child] of Object.entries(properties)) {
			if (!(name in input) || !child || typeof child !== "object" || Array.isArray(child)) continue;
			const childSchema = child as JsonSchema;
			const value = input[name];
			if (!matchesType(value, childSchema.type)) throw new Error(`operation input field ${name} has the wrong type`);
			if (Array.isArray(childSchema.enum) && !childSchema.enum.some((candidate) => Object.is(candidate, value))) throw new Error(`operation input field ${name} is not an allowed value`);
			if (typeof value === "number") {
				if (typeof childSchema.minimum === "number" && value < childSchema.minimum) throw new Error(`operation input field ${name} is below the minimum`);
				if (typeof childSchema.maximum === "number" && value > childSchema.maximum) throw new Error(`operation input field ${name} is above the maximum`);
			}
			if (Array.isArray(value) && childSchema.items && typeof childSchema.items === "object" && !Array.isArray(childSchema.items)) {
				for (const item of value) if (!matchesType(item, (childSchema.items as JsonSchema).type)) throw new Error(`operation input field ${name} has an invalid item`);
			}
		}
	}
}

export class OperationRegistry {
	private readonly definitions = new Map<string, OperationDefinition>();
	register<Input, Output>(definition: OperationDefinition<Input, Output>): void {
		if (!definition.name.trim() || !definition.description.trim() || !definition.inputSchema || !definition.outputSchema) throw new Error("invalid operation definition");
		if (this.definitions.has(definition.name)) throw new Error("operation is already registered");
		this.definitions.set(definition.name, definition as OperationDefinition);
	}
	list(): OperationDefinition[] {
		return [...this.definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
	}
	get(name: string): OperationDefinition {
		const definition = this.definitions.get(name);
		if (!definition) throw new Error("operation is not registered");
		return definition;
	}
	async execute(context: OperationContext, name: string, input: unknown): Promise<unknown> {
		context.signal?.throwIfAborted();
		const definition = this.get(name);
		const rank: Record<OperationScope, number> = { read: 1, write: 2, admin: 3 };
		if (rank[context.scope] < rank[definition.requiredScope]) throw Object.assign(new Error("operation scope is insufficient"), { code: "insufficient_scope", retryable: false, suggestedFix: "Use a principal authorized for the operation required scope." });
		assertObjectInput(input);
		validateSchema(definition.inputSchema, input);
		const authorization = await context.authorize?.(definition, input);
		const authorizedContext = authorization && typeof authorization === "object" && "allowedAccessLabels" in authorization && Array.isArray(authorization.allowedAccessLabels)
			? { ...context, allowedAccessLabels: [...new Set(authorization.allowedAccessLabels.filter((label): label is string => typeof label === "string"))] }
			: context;
		context.signal?.throwIfAborted();
		return definition.execute(authorizedContext, input);
	}
}

export function createBrainRepositoryOperationRegistry(repository: Parameters<typeof executeBrainRepositoryOperation>[0]): OperationRegistry {
	const registry = new OperationRegistry();
	for (const schema of brainRepositoryOperationSchemas) {
		const name = schema.name as BrainRepositoryOperation;
		registry.register({
			name,
			description: schema.description,
			inputSchema: schema.inputSchema,
			outputSchema: { type: "object" },
				requiredScope: name === "purge_deleted_page" ? "admin" : ["install_schema_pack", "set_schema_pack", "repair_brain", "revert_page", "put_page", "move_page", "delete_page", "restore_page", "set_page_access_labels"].includes(name) ? "write" : "read",
			trustBoundary: "remote-safe",
			execute: async (context, input) => {
				const args = input as Record<string, unknown>;
				const graphSources = new Set(["manas-entity", "manas-relationship", "manas-entity-review", "manas-maintenance-proposal", "manas-open-loop", "manas-meeting-preparation"]);
				const graphMutation = () => Object.assign(new Error("Use typed entity, relationship, and owner review operations for managed records."), { code: "graph_lifecycle_required", retryable: false, suggestedFix: "Use entities.put, relationships.put, entities.review.resolve, or maintenance.dismiss with revision checks." });
				if (name === "put_page" && args.source && typeof args.source === "object" && graphSources.has(String((args.source as Record<string, unknown>).type))) throw graphMutation();

				if (typeof repository.snapshot === "function" && (typeof repository.head !== "function" || await repository.head())) {
					const current = await repository.snapshot() as Omit<Awaited<ReturnType<typeof repository.snapshot>>, "pages"> & { pages: Array<{ id: string; path: string; deleted?: boolean; source?: { type: string; provenance?: { metadata?: Record<string, string> } } }> };
					const target = current.pages.find((page) => page.id === args.id || page.path === args.path || page.path === args.from);
                    if (target && !isPrimaryEvidence(target) && ["get_page", "get_page_at", "page_history"].includes(name) && (context.scope !== "admin" || context.allowedAccessLabels !== undefined)) throw Object.assign(new Error("Use the typed record operation for current authorized derived data."), { code: "derived_record_access_required", retryable: false, suggestedFix: "Use loops.get, entities.resolve, relationships.query, questions.get, or maintenance.proposals." });
					if (target && graphSources.has(target.source?.type ?? "") && ["put_page", "move_page", "delete_page", "restore_page", "revert_page", "purge_deleted_page"].includes(name)) throw graphMutation();
					if (target?.source?.type === MEMORY_SOURCE) {
						if (["put_page", "move_page", "delete_page", "restore_page", "revert_page", "purge_deleted_page"].includes(name)) throw new MemoryOperationError("memory_lifecycle_required", "Use memory lifecycle operations for this record.", "Use memory.correct or memory.forget with a revision and idempotency key.");
						if (name === "get_page" && !memoryIsActive(target)) throw new MemoryOperationError("memory_unavailable", "Memory is outside ordinary retrieval.", "Use explicit owner memory.history to inspect earlier assertions.");
						if (["get_page_at", "page_history"].includes(name) && (context.scope !== "admin" || context.allowedAccessLabels !== undefined)) throw new MemoryOperationError("unauthorized", "Memory history requires owner administration.", "Use owner memory.history.");
					}
					if (["list_pages", "export_brain"].includes(name) && current.pages.some((page) => page.source?.type === MEMORY_SOURCE || !isPrimaryEvidence(page))) {
						const selected = name === "export_brain" && typeof args.ref === "string" ? await repository.snapshot(args.ref) as typeof current : current;
						if (context.allowedAccessLabels !== undefined && args.includeDeleted === true) throw new Error("owner history or administration access is required");
						const granted = (page: { accessLabels?: string[] }) => context.allowedAccessLabels === undefined || (page.accessLabels ?? []).every((label) => context.allowedAccessLabels!.includes(label));
						const pages = selected.pages.filter((page) => (args.includeDeleted === true || !page.deleted) && memoryIsActive(page) && isPrimaryEvidence(page) && current.pages.some((entry) => entry.id === page.id && !entry.deleted && memoryIsActive(entry) && granted(entry as { accessLabels?: string[] })) && granted(page as { accessLabels?: string[] }));
						if (context.tenantId && context.tenantId !== ((current as { tenantId?: string }).tenantId ?? "local") || context.brainId && context.brainId !== current.brainId) throw new Error("brain scope is not authorized");
						if (name === "list_pages") return { pages };
						return { brainId: selected.brainId, repositoryId: selected.repositoryId, commit: selected.commit, settings: selected.settings, pages: await Promise.all(pages.map((page) => repository.readPage(selected, page.id))) };
					}
				}

				if (!context.tenantId && !context.brainId && context.allowedAccessLabels === undefined) return executeBrainRepositoryOperation(repository, name, args);
                if (context.allowedAccessLabels === undefined && !context.brainId && (context.tenantId ?? "local") === "local" && !await repository.head()) return executeBrainRepositoryOperation(repository, name, args);
				const snapshot = await repository.snapshot() as Awaited<ReturnType<typeof repository.snapshot>> & { tenantId?: string; pages: Array<{ id: string; path: string; deleted?: boolean; accessLabels?: string[] }> };
				if (context.tenantId && context.tenantId !== (snapshot.tenantId ?? "local") || context.brainId && context.brainId !== snapshot.brainId) throw new Error("brain scope is not authorized");
				const labels = context.allowedAccessLabels;
				if (labels === undefined) return executeBrainRepositoryOperation(repository, name, args);
				for (const key of ["path", "from", "to"]) {
					const path = args[key];
					if (typeof path === "string" && (path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => !segment || segment === "." || segment === ".."))) throw new Error("client paths must be canonical repository-relative paths");
				}
				if (["put_page", "move_page", "delete_page", "set_page_access_labels"].includes(name) && args.expectedHead !== snapshot.commit) throw new Error("repository head changed before authorization");
				const visible = (page: { accessLabels?: string[]; deleted?: boolean; source?: { type: string; provenance?: { metadata?: Record<string, string> } } }) => !page.deleted && memoryIsActive(page) && isPrimaryEvidence(page) && (page.accessLabels ?? []).every((label) => labels.includes(label));
				if (["repair_brain", "install_schema_pack", "set_schema_pack", "page_history", "revert_page", "restore_page", "purge_deleted_page"].includes(name) || args.includeDeleted === true) throw new Error("owner history or administration access is required");
				if (name === "list_pages") return { pages: snapshot.pages.filter(visible) };
				if (name === "brain_status") return { head: snapshot.commit, settings: snapshot.settings, pages: { active: snapshot.pages.filter(visible).length, deleted: 0 } };
				if (name === "export_brain" || name === "get_page_at") {
					const historical = await repository.snapshot(typeof args.ref === "string" ? args.ref : undefined) as typeof snapshot;
					const pages = historical.pages.filter((page) => visible(page) && snapshot.pages.some((current) => current.id === page.id && visible(current)));
					if (name === "get_page_at") {
						const page = pages.find((page) => page.path === args.path);
						if (!page) throw new Error("document is unavailable");
						return repository.readPage(historical, page.id);
					}
					return { brainId: historical.brainId, repositoryId: historical.repositoryId, commit: historical.commit, settings: historical.settings, pages: await Promise.all(pages.map((page) => repository.readPage(historical, page.id))) };
				}
				const path = args.path ?? args.from;
				if (typeof path === "string") {
					const page = snapshot.pages.find((page) => page.path === path);
					if (page && !visible(page) || !page && name !== "put_page") throw new Error("document is unavailable");
				}
				if (name === "move_page" && snapshot.pages.some((page) => page.path === args.to && !visible(page))) throw new Error("document is unavailable");
				if (name === "get_page") {
					const page = snapshot.pages.find((page) => page.path === args.path && visible(page));
					if (!page) throw new Error("document is unavailable");
					return repository.readPage(snapshot, page.id);
				}
				if (name === "set_page_access_labels" && (args.labels as string[]).some((label) => !labels.includes(label))) throw new Error("access label grant is not authorized");
				return executeBrainRepositoryOperation(repository, name, args);
			},
		});
	}
	if (registry.list().length !== brainRepositoryOperationNames.length) throw new Error("operation registry is incomplete");
	return registry;
}


/** Restrict an agent connection to its fixed grant, regardless of transport defaults. */
const ownerMetadataOperations = new Set(["jobs.list", "jobs.schedules", "jobs.cancel", "sources.list", "agent.status", "cache.inspect", "skills.feedback.list"]);
export function isOwnerMetadataOperation(name: string): boolean { return ownerMetadataOperations.has(name); }
export function isScopedClientOperation(definition: OperationDefinition): boolean { return definition.trustBoundary === "remote-safe" && !isOwnerMetadataOperation(definition.name); }

export function scopedClientRegistry(registry: OperationRegistry, grant: OperationContext): OperationRegistry {
 const result = new OperationRegistry();
 const rank: Record<OperationScope, number> = { read: 1, write: 2, admin: 3 };
 for (const definition of registry.list()) {
  if (!isScopedClientOperation(definition) || rank[definition.requiredScope] > rank[grant.scope]) continue;
  result.register({ ...definition, execute: (context, input) => registry.execute({ ...grant, allowedAccessLabels: [...(grant.allowedAccessLabels ?? [])], signal: context.signal }, definition.name, input) });
 }
 return result;
}
