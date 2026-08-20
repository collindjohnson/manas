import { BrainRepository } from "../brain/repository";
import { FilesystemSourceAdapter } from "../sources/filesystem";
import { syncSource } from "../sources/sync";
import { loadState, saveState } from "../state";
import * as operationsModule from "../brain/operations";
import * as operationRegistryModule from "../brain/operation-registry";
import * as protocolModule from "./protocol";
import * as errorsModule from "./errors";
import { createInterface } from "node:readline";
import type { Config } from "../config";
import type { OperationRegistry } from "../brain/operation-registry";
import {
	getService,
	healthService,
	relatedService,
	searchService,
	statusService,
	thinkService,
} from "../brain/services";
import type { SearchMode, SearchOptions } from "../model";


import { MANAS_VERSION } from "@manas-version";

const searchProperties = {
	query: { type: "string" },
	limit: { type: "integer", minimum: 1, maximum: 100 },
	mode: { enum: ["hybrid", "keyword", "semantic"] },
	explain: { type: "boolean" },
	provider: { type: "string" },
	project: { type: "string" },
	repository: { type: "string" },
	workspace: { type: "string" },
	role: { enum: ["user", "assistant"] },
	after: { type: "string" },
	before: { type: "string" },
};
const tools = [
	{
		name: "search",
		description: "Search archived conversations.",
		inputSchema: {
			type: "object",
			properties: searchProperties,
			required: ["query"],
			additionalProperties: false,
		},
	},
	{
		name: "think",
		description: "Grounded synthesis from archived conversations.",
		inputSchema: {
			type: "object",
			properties: { question: { type: "string" } },
			required: ["question"],
			additionalProperties: false,
		},
	},
	{
		name: "get_page",
		description: "Read one Markdown page from the configured brain repository.",
		inputSchema: { type: "object", properties: { path: { type: "string" }, includeDeleted: { type: "boolean" } }, required: ["path"], additionalProperties: false },
	},
	{
		name: "list_pages",
		description: "List pages from the configured brain repository.",
		inputSchema: { type: "object", properties: { includeDeleted: { type: "boolean" } }, additionalProperties: false },
	},
	{
		name: "page_history",
		description: "Read immutable Git history for one brain page.",
		inputSchema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500 } }, required: ["path"], additionalProperties: false },
	},
	{
		name: "revert_page",
		description: "Restore one page from immutable Git bytes.",
		inputSchema: { type: "object", properties: { path: { type: "string" }, ref: { type: "string" }, expectedRevision: { type: "string" }, expectedHead: { type: "string" } }, required: ["path", "ref", "expectedRevision"], additionalProperties: false },
	},
	{
		name: "put_page",
		description: "Create or update a brain page. Updates require expectedRevision.",
		inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, expectedRevision: { type: "string" }, expectedHead: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
	},
	{
		name: "move_page",
		description: "Move a brain page with optimistic concurrency control.",
		inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, expectedRevision: { type: "string" }, expectedHead: { type: "string" } }, required: ["from", "to", "expectedRevision"], additionalProperties: false },
	},
	{
		name: "delete_page",
		description: "Recoverably move a brain page into protected trash.",
		inputSchema: { type: "object", properties: { path: { type: "string" }, expectedRevision: { type: "string" }, expectedHead: { type: "string" } }, required: ["path", "expectedRevision"], additionalProperties: false },
	},
	{
		name: "restore_page",
		description: "Restore a deleted brain page from protected trash.",
		inputSchema: { type: "object", properties: { id: { type: "string" }, path: { type: "string" }, expectedRevision: { type: "string" }, expectedHead: { type: "string" } }, required: ["id", "path", "expectedRevision"], additionalProperties: false },
	},
	{
		name: "sources_list",
		description: "List source identities and stale-document counts.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "sources_sync",
		description: "Synchronize Markdown and text files from one local filesystem source.",
		inputSchema: { type: "object", properties: { sourcePath: { type: "string" }, sourceId: { type: "string" } }, required: ["sourcePath"], additionalProperties: false },
	},
	{
		name: "related",
		description:
			"Find conversations sharing explicit frontmatter relationships.",
		inputSchema: {
			type: "object",
			properties: { manasId: { type: "string" } },
			required: ["manasId"],
			additionalProperties: false,
		},
	},
	{
		name: "status",
		description: "Get metadata-only vault and index status.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "health",
		description: "Get index health without transcript contents.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
];
export const registeredTools = [
	...operationsModule.brainRepositoryOperationSchemas,
	...tools.filter((tool) => !operationsModule.isBrainRepositoryOperation(tool.name)),
];
export function advertisedTools(operationRegistry?: OperationRegistry): Array<Record<string, unknown>> {
	const legacy = registeredTools as Array<Record<string, unknown>>;
	const generated = operationRegistry?.list().map((definition) => ({
		name: definition.name,
		description: definition.description,
		inputSchema: definition.inputSchema,
		_meta: { requiredScope: definition.requiredScope, trustBoundary: definition.trustBoundary },
	})) ?? [];
	const byName = new Map([...legacy, ...generated].map((tool) => [String(tool.name), tool]));
	return [...byName.values()].sort((left, right) => String(left.name).localeCompare(String(right.name)));
}
type Request = {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: unknown;
};
function rpc(
	id: Request["id"],
	result?: unknown,
	error?: { code: number; message: string },
): string {
	return JSON.stringify(
		error
			? { jsonrpc: "2.0", id: id ?? null, error }
			: { jsonrpc: "2.0", id, result },
	);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function validRequest(value: unknown): value is Request {
	return (
		isRecord(value) &&
		value.jsonrpc === "2.0" &&
		typeof value.method === "string" &&
		(value.id === undefined ||
			value.id === null ||
			typeof value.id === "string" ||
			typeof value.id === "number")
	);
}
function requestedProtocolVersion(params: unknown): string {
	return protocolModule.negotiateMcpProtocolVersion(params);
}
function argumentsFor(request: Request): Record<string, unknown> {
	if (
		!isRecord(request.params) ||
		typeof request.params.name !== "string" ||
		(request.params.arguments !== undefined &&
			!isRecord(request.params.arguments))
	)
		throw new Error("invalid params");
	return request.params.arguments ?? {};
}
function only(args: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(args).some((key) => !allowed.includes(key)))
		throw new Error("invalid params");
}

function localBrainRepository() {
	const root = process.env.MANAS_BRAIN_REPOSITORY;
	if (!root) throw errorsModule.mcpConfigurationUnavailableError();
	return new BrainRepository(root);
}

function localOperationRegistry() {
	return operationRegistryModule.createBrainRepositoryOperationRegistry(localBrainRepository());
}

function stringArgument(args: Record<string, unknown>, name: string): string {
	if (typeof args[name] !== "string" || !args[name]) throw new Error("invalid params");
	return args[name] as string;
}
async function handleMcpLine(config: Config, options: { operationRegistry?: OperationRegistry }, line: string, signal: AbortSignal): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			console.log(
				rpc(null, undefined, { code: -32700, message: "parse error" }),
			);
			return;
		}
		if (!validRequest(parsed)) {
			console.log(
				rpc(null, undefined, { code: -32600, message: "invalid request" }),
			);
			return;
		}
		const request = parsed;
		const notification = request.id === undefined;
		try {
			let result: unknown;
			if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;
				if (request.method === "initialize")
					result = {
						protocolVersion: requestedProtocolVersion(request.params),
					capabilities: { tools: {} },
					serverInfo: { name: "manas", version: MANAS_VERSION },
				};
			else if (request.method === "tools/list") result = { tools: advertisedTools(options.operationRegistry) };
			else if (request.method === "tools/call") {
				if (
					!isRecord(request.params) ||
					typeof request.params.name !== "string"
				)
					throw new Error("invalid params");
				const name = request.params.name;
				const args = argumentsFor(request);
				let operationHandled = false;
				if (options.operationRegistry) {
					try {
						options.operationRegistry.get(name);
						operationHandled = true;
						result = await options.operationRegistry.execute({ scope: "admin", principal: "local", tenantId: "local", signal }, name, args);
					} catch (error) {
						if (!(error instanceof Error) || error.message !== "operation is not registered") throw error;
					}
				}
				if (operationHandled) {
					// The shared registry has already validated and executed this operation.
				} else if (operationsModule.isBrainRepositoryOperation(name)) {
					result = await localOperationRegistry().execute({ scope: "admin", principal: "local" }, name, args);
				} else if (name === "search") {
					only(args, Object.keys(searchProperties));
					if (typeof args.query !== "string" || !args.query.trim())
						throw new Error("invalid params");
					const options: SearchOptions = {};
					if (
						(args.limit !== undefined &&
							(typeof args.limit !== "number" ||
								!Number.isInteger(args.limit) ||
								args.limit < 1 ||
								args.limit > 100)) ||
						(args.explain !== undefined && typeof args.explain !== "boolean") ||
						[
							"provider",
							"project",
							"repository",
							"workspace",
							"role",
							"after",
							"before",
						].some(
							(key) => args[key] !== undefined && typeof args[key] !== "string",
						)
					)
						throw new Error("invalid params");
					for (const key of [
						"limit",
						"explain",
						"provider",
						"project",
						"repository",
						"workspace",
						"role",
						"after",
						"before",
					] as const)
						if (args[key] !== undefined)
							(options as Record<string, unknown>)[key] = args[key];
					if (
						args.mode !== undefined &&
						!["hybrid", "keyword", "semantic"].includes(String(args.mode))
					)
						throw new Error("invalid params");
					if (args.mode) options.mode = args.mode as SearchMode;
					result = await searchService(config, args.query, options);
				} else if (name === "think") {
					only(args, ["question"]);
					if (typeof args.question !== "string" || !args.question.trim())
						throw new Error("invalid params");
					result = await thinkService(config, args.question);
				} else if (name === "get_page") {
					only(args, ["path", "includeDeleted"]);
					if (args.includeDeleted !== undefined && typeof args.includeDeleted !== "boolean") throw new Error("invalid params");
					const page = await localBrainRepository().getPage(stringArgument(args, "path"), args.includeDeleted === true);
					if (!page) throw new Error("invalid params");
					result = page;
				} else if (name === "list_pages") {
					only(args, ["includeDeleted"]);
					if (args.includeDeleted !== undefined && typeof args.includeDeleted !== "boolean") throw new Error("invalid params");
					result = { pages: await localBrainRepository().listPages(args.includeDeleted === true) };
				} else if (name === "page_history") {
					only(args, ["path", "limit"]);
					if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500)) throw new Error("invalid params");
					result = { history: await localBrainRepository().pageHistory(stringArgument(args, "path"), args.limit as number | undefined) };
				} else if (name === "revert_page") {
					only(args, ["path", "ref", "expectedRevision", "expectedHead"]);
					if (args.expectedHead !== undefined && typeof args.expectedHead !== "string") throw new Error("invalid params");
					result = await localBrainRepository().revertPage(stringArgument(args, "path"), stringArgument(args, "ref"), stringArgument(args, "expectedRevision"), args.expectedHead as string | undefined);
				} else if (name === "put_page") {
					only(args, ["path", "content", "expectedRevision", "expectedHead"]);
					if ((args.expectedRevision !== undefined && typeof args.expectedRevision !== "string") || (args.expectedHead !== undefined && typeof args.expectedHead !== "string")) throw new Error("invalid params");
					result = await localBrainRepository().putPage(stringArgument(args, "path"), stringArgument(args, "content"), args.expectedRevision as string | undefined, undefined, args.expectedHead as string | undefined);
				} else if (name === "move_page") {
					only(args, ["from", "to", "expectedRevision", "expectedHead"]);
					if (args.expectedHead !== undefined && typeof args.expectedHead !== "string") throw new Error("invalid params");
					result = await localBrainRepository().movePage(stringArgument(args, "from"), stringArgument(args, "to"), stringArgument(args, "expectedRevision"), args.expectedHead as string | undefined);
				} else if (name === "delete_page") {
					only(args, ["path", "expectedRevision", "expectedHead"]);
					if (args.expectedHead !== undefined && typeof args.expectedHead !== "string") throw new Error("invalid params");
					result = await localBrainRepository().deletePage(stringArgument(args, "path"), stringArgument(args, "expectedRevision"), args.expectedHead as string | undefined);
				} else if (name === "restore_page") {
					only(args, ["id", "path", "expectedRevision", "expectedHead"]);
					if (args.expectedHead !== undefined && typeof args.expectedHead !== "string") throw new Error("invalid params");
					result = await localBrainRepository().restorePage(stringArgument(args, "id"), stringArgument(args, "path"), stringArgument(args, "expectedRevision"), args.expectedHead as string | undefined);
				} else if (name === "sources_list") {
					only(args, []);
					const pages = await localBrainRepository().listPages(true);
					const sources = new Map<string, { id: string; documents: number; stale: number }>();
					for (const page of pages) if (page.source) {
						const value = sources.get(page.source.type) ?? { id: page.source.type, documents: 0, stale: 0 };
						value.documents += 1;
						if (page.stale) value.stale += 1;
						sources.set(page.source.type, value);
					}
					result = { sources: [...sources.values()].sort((left, right) => left.id.localeCompare(right.id)) };
				} else if (name === "sources_sync") {
					only(args, ["sourcePath", "sourceId"]);
					if (args.sourceId !== undefined && typeof args.sourceId !== "string") throw new Error("invalid params");
					const state = await loadState(config.stateRoot);
					const checkpoints = {
						get: async (sourceId: string) => state.sourceCheckpoints?.[sourceId],
						set: async (sourceId: string, checkpoint: { updatedAt?: string }) => {
							state.sourceCheckpoints = { ...state.sourceCheckpoints, [sourceId]: checkpoint };
						},
					};
					result = await syncSource(
						new FilesystemSourceAdapter(stringArgument(args, "sourcePath"), args.sourceId as string | undefined),
						localBrainRepository(),
						checkpoints,
					);
					await saveState(config.stateRoot, state);
				} else if (name === "related") {
					only(args, ["manasId", "nessieId"]);
					const manasId = args.manasId ?? args.nessieId;
					if (typeof manasId !== "string")
						throw new Error("invalid params");
					result = await relatedService(config, manasId);
				} else if (name === "health" || name === "status") {
					only(args, []);
					result =
						name === "health"
							? await healthService(config)
							: await statusService(config);
				} else {
					if (!notification)
						console.log(
							rpc(request.id, undefined, {
								code: -32602,
								message: "invalid params",
							}),
						);
					return;
				}
				result = { content: [{ type: "text", text: JSON.stringify(result) }] };
			} else {
				if (!notification)
					console.log(
						rpc(request.id, undefined, {
							code: -32601,
							message: "method not found",
						}),
					);
				return;
			}
			if (!notification) console.log(rpc(request.id, result));
		} catch (error) {
			if (!notification)
				console.log(
					rpc(request.id, undefined, {
						...errorsModule.mcpErrorDetails(error, signal.aborted),
					}),
				);
		}
}

export async function serveMcp(config: Config, options: { operationRegistry?: OperationRegistry } = {}): Promise<void> {
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	const requests = new Map<string, AbortController>();
	const pending = new Set<Promise<void>>();
	await new Promise<void>((resolve, reject) => {
		input.on("line", (line) => {
			let parsed: unknown;
			try { parsed = JSON.parse(line); } catch { parsed = undefined; }
			if (validRequest(parsed) && parsed.method === "notifications/cancelled" && isRecord(parsed.params) && (typeof parsed.params.requestId === "string" || typeof parsed.params.requestId === "number")) {
				requests.get(String(parsed.params.requestId))?.abort();
				return;
			}
			const requestId = validRequest(parsed) && parsed.id !== undefined && parsed.id !== null ? String(parsed.id) : undefined;
			const controller = new AbortController();
			if (requestId) requests.set(requestId, controller);
			const task = handleMcpLine(config, options, line, controller.signal).finally(() => {
				if (requestId && requests.get(requestId) === controller) requests.delete(requestId);
				pending.delete(task);
			});
			pending.add(task);
		});
		input.once("error", reject);
		input.once("close", () => { void Promise.all(pending).then(() => resolve(), reject); });
	});
}
