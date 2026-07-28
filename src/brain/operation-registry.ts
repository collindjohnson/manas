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
		const definition = this.get(name);
		const rank: Record<OperationScope, number> = { read: 1, write: 2, admin: 3 };
		if (rank[context.scope] < rank[definition.requiredScope]) throw new Error("operation scope is insufficient");
		assertObjectInput(input);
		validateSchema(definition.inputSchema, input);
		const authorization = await context.authorize?.(definition, input);
		const authorizedContext = authorization && typeof authorization === "object" && "allowedAccessLabels" in authorization && Array.isArray(authorization.allowedAccessLabels)
			? { ...context, allowedAccessLabels: [...new Set(authorization.allowedAccessLabels.filter((label): label is string => typeof label === "string"))] }
			: context;
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
			execute: (_context, input) => executeBrainRepositoryOperation(repository, name, input as Record<string, unknown>),
		});
	}
	if (registry.list().length !== brainRepositoryOperationNames.length) throw new Error("operation registry is incomplete");
	return registry;
}
