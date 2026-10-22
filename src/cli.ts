#!/usr/bin/env bun
import { realpath } from "node:fs/promises";
import { verifyAgentIntegration } from "./agent-verification";
import { runAgentHook } from "./agent-hook-runtime";
import { manageAgentMcp, liveClientRegistry } from "./agent-mcp";
import { manageAgentHooks } from "./agent-hooks";
import { executableCommand } from "./executable";
import { previewAgentInstallation, installAgentSkills, agentInstallationStatus, uninstallAgentSkills, type ManagedAgent } from "./agent-management";
import { MemoryOperationError } from "./brain/memory";
import { activateCanonicalArchive, loadCanonicalSelection, rollbackCanonicalArchive, shadowArchiveMigration, type CanonicalSelection } from "./canonical-runtime";
import { applyArchiveMigration, previewArchiveMigration, readArchiveMigration } from "./archive-migration";

import { importOfficialExport } from "./imports/exports";
import { loadConfig, type Config } from "./config";
import { createBrainEngine, createBrainProviders } from "./engine";
import { callLocalService, LocalServiceError, localServiceRegistry, startLocalService } from "./local-service";
import { installLaunchAgent } from "./launch-agent";
import { runtimeBackupOperations } from "./runtime-backup";
import { installService, previewServiceInstallation, previewServiceRemoval, serviceInstallationStatus, uninstallService } from "./service-installation";
import { scanArchive } from "./archive";
import { verifyArchive } from "./report";

import { discoverLocalSources, runSync } from "./sync";
import { indexArchive } from "./brain/indexer";
import { openBrainDatabase, assertBrainIntegrity } from "./brain/database";
import {
	getService,
	healthService,
	relatedService,
	searchService,
	statusService,
	thinkService,
} from "./brain/services";
import { serveMcp } from "./mcp/server";
import type { Provider, SearchMode } from "./model";

import { MANAS_VERSION } from "@manas-version";
import { migrateIdentifiers } from "@manas/identifier-migration";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { installCompiledBinary } from "@manas/installer";
import { isCompiledExecutable } from "@manas/executable";

import { writeScheduledSyncReceipt } from "@manas/scheduler-receipt";

import { BrainRepository } from "./brain/repository";
import { migrateLegacyArchive, preflightChatHistorySyncMigration } from "./migration";
import { openPgliteBrainStore } from "./brain/store";
import { StoreOwnedError } from "./brain/ownership";
import * as operationRegistryModule from "./brain/operation-registry";
import * as operationCatalogModule from "./brain/operation-catalog";
import * as controlPlaneModule from "./brain/control-plane";
import { serveMcpHttp } from "./mcp/http";
import { callMcpHttp } from "./mcp/client";
import { authorizePersonalAccessToken, identifyPersonalAccessToken } from "./brain/access-tokens";
import { SqlTenantDirectory } from "./brain/tenancy";
import { setupManas, setupJsonDocument } from "./setup";

import { parseGlobalArguments } from "@manas/global-options";

const LOCAL_PROVIDERS: Provider[] = [
	"claude_code",
	"codex",
	"pi",
	"cursor",
	"grok",
];


let selectedCanonicalRuntime: CanonicalSelection | undefined;

const CATALOG_COMMANDS: Record<string, Record<string, string>> = {
 reminders: { enqueue: "reminders.enqueue", list: "reminders.list" },
 meetings: { prepare: "meetings.prepare", get: "meetings.get" },
 loops: { put: "loops.put", status: "loops.status", get: "loops.get", list: "loops.list" },
 execution: { start: "execution.start", status: "execution.status", list: "execution.list", cancel: "execution.cancel" },
 google: { schedule: "google.sources.schedule", connect: "google.accounts.connect", enable: "google.sources.enable", add: "google.sources.add", status: "google.sources.status", sync: "google.sources.sync" },
 entities: { put: "entities.put", resolve: "entities.resolve", reviews: "entities.reviews", review: "entities.review.resolve" },
 relationships: { put: "relationships.put", query: "relationships.query" },
 answers: { get: "answers.get", feedback: "answers.feedback", "feedback-reset": "answers.feedback.reset" },
 questions: { put: "questions.put", get: "questions.get", list: "questions.list", refresh: "questions.refresh" },
	models: { diagnose: "models.diagnose", activate: "models.activate" },
	agents: { start: "agent.start", status: "agent.status", update: "agent.update" },
	autopilot: { start: "agent.start", status: "agent.status", update: "agent.update" },
	context: { deliver: "context.deliver" },
	memory: { remember: "memory.remember", recall: "memory.recall", correct: "memory.correct", forget: "memory.forget", history: "memory.history" },
	jobs: { "run-one": "jobs.run-one", list: "jobs.list", enqueue: "jobs.enqueue", cancel: "jobs.cancel", schedule: "jobs.schedule", schedules: "jobs.schedules" },
	dream: { run: "jobs.enqueue", maintenance: "maintenance.propose" },
	maintenance: { propose: "maintenance.propose", scan: "maintenance.scan", proposals: "maintenance.proposals", dismiss: "maintenance.dismiss", accept: "maintenance.accept" },
	sources: { list: "sources.list", enable: "sources.enable" },
	plugins: { list: "sources.list" },
	schema: { plan: "schema.upgrade.plan", approve: "schema.upgrade.approve", apply: "schema.upgrade.apply" },
	upgrade: { plan: "schema.upgrade.plan", approve: "schema.upgrade.approve", apply: "schema.upgrade.apply" },
	skills: { list: "skills.list", resolve: "skills.resolve", propose: "skills.propose", feedback: "skills.feedback", "feedback-list": "skills.feedback.list", "optimizer-propose": "skills.optimizer-propose" },
	admin: { dashboard: "admin.dashboard", audit: "admin.audit", "audit-page": "admin.audit.page", "user-create": "admin.user.create", "tenant-create": "admin.tenant.create", "brain-create": "admin.brain.create", "membership-grant": "admin.membership.grant", "group-create": "admin.group.create", "group-member-add": "admin.group.member-add", "visibility-grant": "admin.visibility.grant", "source-register": "admin.source.register", "oauth-client-create": "admin.oauth-client.create", "oauth-client-revoke": "admin.oauth-client.revoke", "token-create": "admin.token.create", "token-list": "admin.token.list", "token-revoke": "admin.token.revoke" },
	cache: { check: "cache.inspect" },
	storage: { check: "integrity.check" },
	integrity: { check: "integrity.check" },
	anomaly: { check: "analysis.anomaly" },
	evaluation: { check: "analysis.evaluate" },
	analysis: { features: "analysis.features", evaluate: "analysis.evaluate", code: "analysis.code", docs: "analysis.docs", brainstorm: "analysis.brainstorm", scorecard: "analysis.scorecard", calibrate: "analysis.calibrate", recall: "analysis.recall", forget: "analysis.forget", contributor: "analysis.contributor", replay: "analysis.replay", trajectory: "analysis.trajectory", diagnose: "analysis.diagnose", anomaly: "analysis.anomaly", sources: "analysis.route.sources", brains: "analysis.route.brains" },
	rollback: { record: "rollback.record" },
	connect: { session: "auth.session.create", revoke: "auth.session.revoke" },
};

async function executeCatalogCommand(command: string, args: string[], config: Config): Promise<unknown> {
 const connecting = command === "google" && args[0] === "connect" || command === "operation" && args[0] === "google.accounts.connect";
 if (!connecting) return executeCatalogCommandWithSignal(command, args, config);
 const abort = new AbortController(), cancel = () => abort.abort();
 process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
 try { return await executeCatalogCommandWithSignal(command, args, config, abort.signal); }
 finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}
function legacyBrainProviders(operation: string, args: string[], config: Config): { config: Config; requested: Record<string, unknown> } {
 if (!["retrieval.search", "projection.embed"].includes(operation)) return { config, requested: {} };
 const providers = { ...config.providers };
 const requested: Record<string, unknown> = {};
 const embeddingEndpoint = option(args, "--embedding-endpoint"), embeddingModel = option(args, "--embedding-model"), rawDimensions = option(args, "--embedding-dimensions");
 if (embeddingEndpoint !== undefined || embeddingModel !== undefined || rawDimensions !== undefined) {
  const dimensions = Number(rawDimensions);
  if (!embeddingEndpoint || !embeddingModel || !Number.isInteger(dimensions) || dimensions < 1) throw new Error("embedding flags require endpoint, model, and positive integer dimensions");
  requested.embedding = { endpoint: embeddingEndpoint, model: embeddingModel, dimensions };
  providers.embedding = { endpoint: embeddingEndpoint, model: embeddingModel, dimensions, privacy: "local", apiKey: config.providers?.embedding?.endpoint === embeddingEndpoint ? config.providers.embedding.apiKey : process.env.MANAS_EMBEDDING_API_KEY };
 }
 const rerankerEndpoint = option(args, "--reranker-endpoint"), rerankerModel = option(args, "--reranker-model");
 if (rerankerEndpoint !== undefined || rerankerModel !== undefined) {
  if (!rerankerEndpoint || !rerankerModel) throw new Error("reranking requires both --reranker-endpoint and --reranker-model");
  requested.reranking = { endpoint: rerankerEndpoint, model: rerankerModel };
  const existing = config.providers?.reranking;
  providers.reranking = { ...(existing?.endpoint === rerankerEndpoint && existing.model === rerankerModel ? existing : {}), endpoint: rerankerEndpoint, model: rerankerModel, privacy: "local", apiKey: existing?.endpoint === rerankerEndpoint ? existing.apiKey : process.env.MANAS_RERANKER_API_KEY };
 }
 return { config: Object.keys(requested).length ? { ...config, providers } : config, requested };
}

async function executeCatalogCommandWithSignal(command: string, args: string[], config: Config, signal?: AbortSignal): Promise<unknown> {
	const operation = command === "operation" ? args[0] : CATALOG_COMMANDS[command]?.[args[0] ?? ""];
	if (!operation) throw new Error(`usage: ${command} <operation> --input <json> --repo <path> [--store <pglite-directory>]`);
	const inputText = option(args, "--input");
	let input: Record<string, unknown> = {};
	if (inputText) {
		const parsed = JSON.parse(inputText) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--input must be a JSON object");
		input = parsed as Record<string, unknown>;
	}
	const legacyProviders = legacyBrainProviders(operation, args, config);
	const remoteUrl = option(args, "--mcp-url");
	if (remoteUrl) {
		const token = option(args, "--mcp-token") ?? process.env.MANAS_MCP_TOKEN;
		if (!token) throw new Error("both --mcp-url and --mcp-token (or MANAS_MCP_TOKEN) are required");
		return callMcpHttp(remoteUrl, token, operation, input);
	}
	try {
		await callLocalService(config, "service.status", {}, { timeoutMs: 2_000, repositoryRoot: option(args, "--repo") });
	} catch (error) {
		if (!(error instanceof LocalServiceError) || error.code !== "service_unavailable") throw error;
		return executeStandaloneCatalogCommand(operation, input, args, legacyProviders.config, signal);
	}
	if (Object.keys(legacyProviders.requested).length) await callLocalService(config, "runtime.assert-providers", legacyProviders.requested, { repositoryRoot: option(args, "--repo"), context: catalogContext(args), signal });
	return callLocalService(config, operation, input, { repositoryRoot: option(args, "--repo"), context: catalogContext(args), signal });
}

function catalogContext(args: string[]) {
	const requestedScope = option(args, "--scope") ?? "admin";
	if (!["read", "write", "admin"].includes(requestedScope)) throw new Error("--scope must be read, write, or admin");
	return { scope: requestedScope as "read" | "write" | "admin", principal: "cli", tenantId: option(args, "--tenant") ?? "local", ...(option(args, "--brain") ? { brainId: option(args, "--brain") } : {}) };
}

async function executeStandaloneCatalogCommand(operation: string, input: Record<string, unknown>, args: string[], config: Config, signal?: AbortSignal): Promise<unknown> {
 const requestedRoot = option(args, "--repo") ?? process.env.MANAS_BRAIN_REPOSITORY ?? selectedCanonicalRuntime?.repositoryRoot;
 const selectedStore = selectedCanonicalRuntime && requestedRoot && await realpath(requestedRoot).catch(() => resolve(requestedRoot)) === await realpath(selectedCanonicalRuntime.repositoryRoot).catch(() => resolve(selectedCanonicalRuntime!.repositoryRoot)) ? selectedCanonicalRuntime.storePath : undefined;
 const storePath = option(args, "--store") ?? selectedStore ?? (["notes.capture", "sources.filesystem.sync", "sources.local.import"].includes(operation) ? resolve(config.stateRoot, "runtime") : undefined);
	const hasRepository = Boolean(option(args, "--repo") || process.env.MANAS_BRAIN_REPOSITORY || selectedCanonicalRuntime);
	const repository = hasRepository ? brainRepository(args) : new BrainRepository(storePath ?? ".");
	const engine = hasRepository ? await createBrainEngine({ repositoryRoot: repository.root, storePath, config }) : undefined;
	const store = engine?.store ?? (storePath ? await openPgliteBrainStore(storePath) : undefined);
	try {
		const providers = engine?.providers ?? createBrainProviders(config);
		const registry = engine?.operations ?? operationCatalogModule.createFullOperationRegistry({ repository, backupConfig: config, stateRoot: config.stateRoot, embeddingProvider: providers.embedding, rerankerProvider: providers.reranking, generationProvider: providers.generation, transcriptionProvider: providers.transcription, ...(store ? { store, controlPlane: new controlPlaneModule.DurableControlPlane(store) } : {}) });
		return await registry.execute({ ...catalogContext(args), signal }, operation, input);
	} finally { if (engine) await engine.close(); else await store?.close(); }
}

function usage(): string {
	return `manas [--config <path>]

Configuration precedence:
  --config <path> → MANAS_CONFIG_FILE → home .config/manas/config.json → built-in defaults

Commands:
  service start --repo <brain> [--store <state-directory>] | status | stop
  setup [--archive <path>] [--config <path>] [--yes] [--no-schedule] [--detect-only|--preview|--repair] [--retire-legacy] [--json]
  sync [--config <path>] [--provider <name>] [--dry-run|--scheduled]
  import chatgpt <zip-or-json>
  import claude <zip-or-json>
  install
  verify
  install-launch-agent --config <path>
  status|sync-status [--config <path>]
  migrate-chat-history-sync --config <path>
  migrate-identifiers [--preview|--yes] [--json]
  index [--rebuild|--repair]
  search <query> [--limit <1-100>] [--keyword-only|--semantic-only]
  remember|recall|correct|forget --input <json> [--repo <brain> --store <state-directory>]
  memory history --input <json> [--repo <brain>]
  google connect|add|enable|status|sync|schedule --input <json>
  entities put|resolve|reviews --input <json>
  relationships put|query --input <json>
  questions put|get|list|refresh --input <json>
  answers get|feedback|feedback-reset --input <json>
  migration preview|resume|status|shadow|activate|rollback
  ui start|open|status|stop [--port <port>]
  devices peers|preview|enable|status|disable [--input <json>] [--preview]
  agents preview|install|status|uninstall codex|claude-code [--capture] [--write]
  agents verify codex|claude-code --query <visible evidence query>
  service start|status|stop|preview|install|installation-status|uninstall
  backup create|verify|restore
  think <question>
  get <manas-id>
  related <manas-id>
  health
  jobs list|enqueue-index|schedule-index|schedules|run-one|cancel [--store <pglite-directory>] [--repo <brain-repository>] [--id <job-id>] [--at <ISO-timestamp>] [--every-seconds <seconds>] [--limit <1-1000>]
  serve [--http-port <port>]
  auth create|list|events|revoke [--store <pglite-directory>]
  models diagnose|activate, agents, autopilot, dream, maintenance, sources, plugins, schema, upgrade, skills, admin, cache, storage, integrity, anomaly, evaluation, analysis, rollback, connect
	  operation <catalog-operation> --input <json> --repo <path> [--store <pglite-directory>] | --mcp-url <url> --mcp-token <token>
  doctor [--json]
  capture <markdown> | capture --file <path> | capture --stdin
  brain init|migrate|verify|doctor|repair|history|revert|status|schema|access|index|embed|search|related|sources-list|sources-sync|import|extract|export|list|get|put|move|delete|restore --repo <path>`;
}

function brainRepository(args: string[]) {
	const supplied = option(args, "--repo");
	const root = supplied ?? process.env.MANAS_BRAIN_REPOSITORY ?? selectedCanonicalRuntime?.repositoryRoot;
	if (!root) throw new Error("brain repository must be supplied with --repo or MANAS_BRAIN_REPOSITORY");
	return new BrainRepository(root);
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`missing value for ${name}`);
	if (args.indexOf(name, index + 1) >= 0)
		throw new Error(`duplicate option ${name}`);
	return value;
}

function rejectUnknownFlags(args: string[], allowed: string[]): void {
	for (const value of args)
		if (value.startsWith("--") && !allowed.includes(value))
			throw new Error(`unknown option: ${value}`);
}

function rejectUnexpectedArguments(
	args: string[],
	valueOptions: string[],
): void {
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index];
		if (valueOptions.includes(value)) {
			index += 1;
			continue;
		}
		if (!value.startsWith("--")) throw new Error(`unexpected argument: ${value}`);
	}
}

function rejectDuplicateFlags(args: string[], flags: string[]): void {
	for (const flag of flags)
		if (args.filter((value) => value === flag).length > 1)
			throw new Error(`duplicate option ${flag}`);
}

function requireNoArguments(command: string, args: string[]): void {
	if (args.length) throw new Error(`${command} does not accept arguments`);
}

function providerOption(args: string[]): Provider | undefined {
	const value = option(args, "--provider");
	if (!value) return undefined;
	if (!LOCAL_PROVIDERS.includes(value as Provider))
		throw new Error(`unsupported local provider: ${value}`);
	return value as Provider;
}

function scheduledAt(args: string[]): Date | undefined {
	const value = option(args, "--at");
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error("--at must be an ISO timestamp");
	return date;
}

function mcpScopes(): Array<"read" | "write" | "admin"> {
	const values = (process.env.MANAS_MCP_SCOPES ?? "read,write").split(",").map((value) => value.trim()).filter(Boolean);
	if (!values.length || values.some((value) => value !== "read" && value !== "write" && value !== "admin")) throw new Error("MANAS_MCP_SCOPES must contain read, write, and/or admin");
	return [...new Set(values)] as Array<"read" | "write" | "admin">;
}

function hostedOperationAuthorizer(store: ConstructorParameters<typeof SqlTenantDirectory>[0]) {
	const directory = new SqlTenantDirectory(store);
	return async (principal: { id: string; tenantId: string; userId?: string }, definition: { requiredScope: "read" | "write" | "admin" }, input: Record<string, unknown>): Promise<void | { allowedAccessLabels?: string[] }> => {
		if (!principal.userId) return;
		const brainId = typeof input.brainId === "string" ? input.brainId : undefined;
		const labels = Array.isArray(input.labels) ? input.labels.filter((label): label is string => typeof label === "string") : [];
		const authorization = await directory.authorizeWithLabels(principal.userId, principal.tenantId, brainId, definition.requiredScope);
		const allowedAccessLabels = authorization.allowedAccessLabels;
		if (allowedAccessLabels && labels.some((label) => !allowedAccessLabels.includes(label))) throw new Error("scope is not authorized");
		return { allowedAccessLabels };
	};
}

function success(command: string, data: unknown): void {
	console.log(JSON.stringify({ ok: true, command, data }, null, 2));
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string"
	)
		return error.message;
	if (typeof error === "string") return error;
	return "request failed";
}

function failure(command: string | undefined, error: unknown): void {
	const message = errorMessage(error);
	if (command === "setup") {
		const category = message.startsWith("unknown option") || message.startsWith("unexpected argument") || message.startsWith("missing value") || message.startsWith("duplicate option") || message.startsWith("choose either") || message.includes("require --yes")
			? { exitCode: 2, code: "invalid_request" }
			: message.includes("source") || message.includes("no supported local")
				? { exitCode: 3, code: "source_detection_failed" }
				: message.includes("archive") || message.includes("configuration")
					? { exitCode: 4, code: "preflight_failed" }
					: message.includes("preview") || message.includes("targets changed")
						? { exitCode: 5, code: "plan_revalidation_failed" }
						: message.includes("scheduler") || message.includes("LaunchAgent") || message.includes("scheduled sync")
							? { exitCode: 6, code: "scheduler_activation_failed" }
							: { exitCode: 7, code: "setup_failed" };
		const partial = error as Error & { setupExitCode?: number; setupCode?: string; setupPartial?: Parameters<typeof setupJsonDocument>[0] };
		const base = partial.setupPartial ? setupJsonDocument(partial.setupPartial) : { schema: "manas.setup.v1", version: MANAS_VERSION, mode: null, config: null, sources: null, preview: null, sync: null, scheduler: null, legacy: null };
		const exitCode = partial.setupExitCode ?? category.exitCode;
		console.log(JSON.stringify({ ...base, exitCode, error: { code: partial.setupCode ?? category.code, message } }));
		process.exitCode = exitCode;
		return;
	}
 const domain = error as Error & { code?: unknown; retryable?: unknown; suggestedFix?: unknown };
 if (error instanceof LocalServiceError || error instanceof StoreOwnedError || error instanceof MemoryOperationError || error instanceof Error && typeof domain.code === "string" && typeof domain.retryable === "boolean" && typeof domain.suggestedFix === "string") {
		console.log(JSON.stringify({ ok: false, command: command ?? "unknown", error: { code: domain.code, message: domain.message, retryable: domain.retryable, suggestedFix: domain.suggestedFix } }, null, 2));
		return;
	}
	const diagnosticMessage = process.env.MANAS_DIAGNOSTICS === "1" ? message.slice(0, 1_000) : undefined;
	const safePrefixes = [
		"unknown option",
		"unexpected argument",
		"missing value",
		"duplicate option",
		"unsupported local provider",
		"choose either",
		"usage:",
		"unknown command",
		"search query",
		"mode must be",
		"limit must be",
		"role must be",
		"after must be",
		"before must be",
		"question must",
		"think does not accept",
		"verify does not accept",
		"status does not accept",
		"health does not accept",
		"doctor does not accept",
		"install-launch-agent does not accept",
		"configuration file",
		"expected Obsidian chat-history vault",
		"existing archive verification failed",
		"migrate-chat-history-sync requires",
		"setup ",
		"no supported local AI chat sources",
		"source detection reported failures",
		"selected archive verification failed",
		"initial setup sync reported failures",
		"automatic scheduling is currently supported",
		"could not create the Manas configuration directory",
		"could not secure the Manas configuration file",
		"could not load the Manas LaunchAgent",
		"could not reload the Manas LaunchAgent",
		"self-install requires",
		"scheduling requires",
		"scheduled sync requires",
		"brain schema ",
	];
	const safe = safePrefixes.some((prefix) => message.startsWith(prefix))
		? message.slice(0, 300)
		: "request failed";
	console.log(
		JSON.stringify({
			ok: false,
			command: command ?? "unknown",
			error: { code: "invalid_request", message: diagnosticMessage ?? safe },
		}),
	);
}

async function remoteBrainOperation(subcommand: string | undefined, args: string[]): Promise<unknown> {
	const url = option(args, "--mcp-url");
	const token = option(args, "--mcp-token") ?? process.env.MANAS_MCP_TOKEN;
	if (!url || !token) throw new Error("both --mcp-url and --mcp-token (or MANAS_MCP_TOKEN) are required");
	if (subcommand === "status") return callMcpHttp(url, token, "brain_status", {});
	if (subcommand === "schema") {
		const id = option(args, "--schema-id");
		const version = option(args, "--schema-version");
		const schemaFile = option(args, "--schema-file");
		if (args.includes("--list-packs")) return callMcpHttp(url, token, "list_schema_packs", {});
		if (schemaFile) {
			if (id || version) throw new Error("schema file cannot be activated in the same command");
			return callMcpHttp(url, token, "install_schema_pack", { pack: JSON.parse(await Bun.file(schemaFile).text()), expectedHead: option(args, "--expected-head") });
		}
		if (!id && !version) return callMcpHttp(url, token, "get_schema", {});
		if (!id || !version) throw new Error("usage: brain schema --schema-id <id> --schema-version <version>");
		return callMcpHttp(url, token, "set_schema_pack", { id, version, expectedHead: option(args, "--expected-head") });
	}
	if (subcommand === "list") return callMcpHttp(url, token, "list_pages", { includeDeleted: args.includes("--include-deleted") });
	if (subcommand === "export") {
		const ref = option(args, "--ref");
		return callMcpHttp(url, token, "export_brain", { ...(ref ? { ref } : {}), includeDeleted: args.includes("--include-deleted") });
	}
	if (subcommand === "history") {
		const path = option(args, "--path");
		if (!path) throw new Error("usage: brain history --path <path> [--limit <1-500>]");
		return callMcpHttp(url, token, "page_history", { path, limit: Number(option(args, "--limit") ?? "50") });
	}
	if (subcommand === "repair") return callMcpHttp(url, token, "repair_brain", { expectedHead: option(args, "--expected-head") });
	if (subcommand === "get") {
		const path = option(args, "--path");
		if (!path) throw new Error("usage: brain get --path <path>");
		const ref = option(args, "--ref");
		return callMcpHttp(url, token, ref ? "get_page_at" : "get_page", ref ? { path, ref } : { path, includeDeleted: args.includes("--include-deleted") });
	}
	if (subcommand === "put") {
		const path = option(args, "--path");
		const content = option(args, "--content");
		if (!path || content === undefined) throw new Error("usage: brain put --path <path> --content <markdown>");
		const expectedRevision = option(args, "--expected-revision");
		return callMcpHttp(url, token, "put_page", { path, content, ...(expectedRevision ? { expectedRevision } : {}), expectedHead: option(args, "--expected-head") ?? null });
	}
	if (subcommand === "move") {
		const from = option(args, "--from");
		const to = option(args, "--to");
		const expectedRevision = option(args, "--expected-revision");
		if (!from || !to || !expectedRevision) throw new Error("usage: brain move --from <path> --to <path> --expected-revision <revision>");
		return callMcpHttp(url, token, "move_page", { from, to, expectedRevision, expectedHead: option(args, "--expected-head") });
	}
	if (subcommand === "delete") {
		const path = option(args, "--path");
		const expectedRevision = option(args, "--expected-revision");
		if (!path || !expectedRevision) throw new Error("usage: brain delete --path <path> --expected-revision <revision>");
		return callMcpHttp(url, token, "delete_page", { path, expectedRevision, expectedHead: option(args, "--expected-head") });
	}
	if (subcommand === "restore") {
		const id = option(args, "--id");
		const path = option(args, "--path");
		const expectedRevision = option(args, "--expected-revision");
		if (!id || !path || !expectedRevision) throw new Error("usage: brain restore --id <id> --path <path> --expected-revision <revision>");
		return callMcpHttp(url, token, "restore_page", { id, path, expectedRevision, expectedHead: option(args, "--expected-head") });
	}
	if (subcommand === "purge") {
		const id = option(args, "--id");
		if (!args.includes("--confirm-purge") || !id) throw new Error("usage: brain purge --id <deleted-page-id> --confirm-purge --expected-head <git-commit>");
		const retentionDays = option(args, "--retention-days");
		return callMcpHttp(url, token, "purge_deleted_page", { id, expectedHead: option(args, "--expected-head"), ...(retentionDays ? { retentionDays: Number(retentionDays) } : {}) });
	}
	if (subcommand === "access") {
		const path = option(args, "--path");
		const labels = option(args, "--labels");
		const expectedRevision = option(args, "--expected-revision");
		if (!path || labels === undefined || !expectedRevision) throw new Error("usage: brain access --path <path> --labels <comma-separated-labels> --expected-revision <revision>");
		return callMcpHttp(url, token, "set_page_access_labels", { path, labels: labels ? labels.split(",") : [], expectedRevision, expectedHead: option(args, "--expected-head") });
	}
	if (subcommand === "revert") {
		const path = option(args, "--path");
		const ref = option(args, "--ref");
		const expectedRevision = option(args, "--expected-revision");
		if (!path || !ref || !expectedRevision) throw new Error("usage: brain revert --path <path> --ref <commit> --expected-revision <revision>");
		return callMcpHttp(url, token, "revert_page", { path, ref, expectedRevision, expectedHead: option(args, "--expected-head") });
	}
	throw new Error("remote brain mode supports shared page, schema, status, history, list, and export operations");
}

let invokedCommand: string | undefined;

async function main(): Promise<void> {
	const { args, configPath } = parseGlobalArguments(process.argv.slice(2));
	const command = args[0];
	invokedCommand = command;
	if (args.includes("--allow-hosted-model")) throw new MemoryOperationError("local_inference_required", "Manas-managed inference must stay local.", "Configure a loopback model endpoint and remove --allow-hosted-model.");
	if (command === "--version" || command === "version") {
		console.log(MANAS_VERSION);
		return;
	}
	if (!command || command === "help" || command === "--help") {
		success("help", { usage: usage() });
		return;
	}
	if (command === "setup") {
		rejectUnknownFlags(args.slice(1), [
			"--archive",
			"--config",
			"--yes",
			"--no-schedule",
			"--detect-only",
			"--preview",
			"--allow-empty",
			"--retire-legacy",
			"--repair",
			"--json",
		]);
		rejectUnexpectedArguments(args.slice(1), ["--archive", "--config"]);
		rejectDuplicateFlags(args.slice(1), ["--yes", "--no-schedule", "--detect-only", "--preview", "--repair", "--allow-empty", "--retire-legacy", "--json"]);
		if (args.includes("--detect-only") && args.includes("--preview"))
			throw new Error("choose either --detect-only or --preview");
		if (args.includes("--repair") && (args.includes("--detect-only") || args.includes("--preview") || args.includes("--no-schedule")))
			throw new Error("repair cannot be combined with detect-only, preview, or no-schedule");
		if (!args.includes("--detect-only") && !args.includes("--preview") && !args.includes("--yes"))
			throw new Error("setup mutations require --yes when emitting JSON");
		if (args.includes("--retire-legacy") && (args.includes("--detect-only") || args.includes("--preview") || !args.includes("--yes")))
			throw new Error("legacy retirement requires --yes and cannot be combined with detect-only or preview");
		const setup = { setupManas, setupJsonDocument };
		const result = await setup.setupManas({
			archiveRoot: option(args, "--archive"),
			configPath,
			yes: args.includes("--yes"),
			noSchedule: args.includes("--no-schedule"),
			detectOnly: args.includes("--detect-only"),
			previewOnly: args.includes("--preview"),
			allowEmpty: args.includes("--allow-empty"),
			retireLegacy: args.includes("--retire-legacy"),
			repair: args.includes("--repair"),
		});
		console.log(JSON.stringify(setup.setupJsonDocument(result)));
		return;
	}
	if (command === "migrate-chat-history-sync") {
		requireNoArguments(command, args.slice(1));
		if (!configPath) throw new Error("migrate-chat-history-sync requires --config <path>");
		const migration = { preflightChatHistorySyncMigration };
		success(command, await migration.preflightChatHistorySyncMigration(configPath));
		return;
	}
	const config = await loadConfig({ ...(configPath ? { filePath: configPath } : {}) });
	if (command === "hook") {
		let input: unknown;
		try {
			const read = async () => {
				const chunks: Uint8Array[] = []; let size = 0;
				for await (const chunk of Bun.stdin.stream()) { size += chunk.byteLength; if (size > 65536) throw new Error("hook input too large"); chunks.push(chunk); }
				return JSON.parse(Buffer.concat(chunks).toString("utf8"));
			};
			input = await read();
		} catch { console.log("{}"); return; }
		const agent = option(args, "--agent");
		console.log(JSON.stringify(agent === "codex" || agent === "claude-code" ? await runAgentHook(config, agent, input, option(args, "--installation")) : {}));
		return;
	}
 if (command === "agents" && args[1] === "verify") {
  rejectUnknownFlags(args.slice(3), ["--home", "--query"]);
  const agent = args[2], query = option(args, "--query");
  if (!configPath || !["codex", "claude-code"].includes(agent) || !query) throw new Error("usage: agents verify codex|claude-code --config <path> --query <visible evidence query>");
  success(command, await verifyAgentIntegration(config, { agent: agent as ManagedAgent, home: option(args, "--home") ?? homedir(), stateRoot: config.stateRoot, configPath }, query));
  return;
 }
	if (command === "agents" && ["preview", "install", "uninstall", "status"].includes(args[1]) && ["codex", "claude-code"].includes(args[2])) {
        rejectUnknownFlags(args.slice(3), ["--home", "--capture", "--visibility", "--write", "--no-mcp"]);
        if (["install", "uninstall"].includes(args[1]) && !configPath) throw new Error("agent install/uninstall requires an explicit --config");
        const visibility: unknown = option(args, "--visibility") ? JSON.parse(option(args, "--visibility")!) : args.includes("--capture") ? ["personal"] : [];
        if (!Array.isArray(visibility) || visibility.some((label) => typeof label !== "string" || !label.trim())) throw new Error("--visibility must be a JSON array of labels");
        const options = { agent: args[2] as ManagedAgent, home: option(args, "--home") ?? homedir(), stateRoot: config.stateRoot };
        const managed = { ...options, capture: args.includes("--capture"), write: args.includes("--write"), visibility: ["status", "uninstall"].includes(args[1]) && !option(args, "--visibility") ? undefined : visibility as string[], configPath: configPath ?? "", executable: executableCommand({ execPath: process.execPath, bunPath: Bun.which("bun") ?? undefined, entrypoint: import.meta.path }) };
        const mode = args[1] as "preview" | "install" | "status" | "uninstall";
        if (mode === "install") {
            await manageAgentHooks(managed, "preview");
            if (!args.includes("--no-mcp") && (await manageAgentMcp(managed, "preview")).action === "conflict") throw new Error("Existing manas MCP configuration is not owned; inspect preview or use --no-mcp.");
        }
        const action = mode === "preview" ? previewAgentInstallation : mode === "install" ? installAgentSkills : mode === "uninstall" ? uninstallAgentSkills : agentInstallationStatus;
        const skills = await action(options);
        const hooks = configPath ? await manageAgentHooks(managed, mode) : { hooksInstalled: false, suggestedFix: "Supply --config to manage agent hooks." };
        // Uninstall always revokes a previously managed grant, including when config edits must be retained.
        const mcp = configPath && (!args.includes("--no-mcp") || mode === "uninstall") ? await manageAgentMcp(managed, mode) : { skipped: true };
        success(command, { skills, hooks, mcp });
		return;
	}
	const selection = await loadCanonicalSelection(config);
	selectedCanonicalRuntime = selection?.mode === "canonical" ? selection : undefined;
 if (command === "ui") {
  rejectUnknownFlags(args.slice(2), ["--port", "--json", "--config", "--no-browser"]);
  if (!["start", "open", "status", "stop"].includes(args[1] ?? "")) throw new Error("usage: ui start|open|status|stop [--port <port>]");
  const port = option(args, "--port");
  if (port !== undefined && !/^[0-9]+$/.test(port)) throw new Error("--port must be an integer");
  if (port !== undefined && !["start", "open"].includes(args[1])) throw new Error("--port is supported by ui start and open");
  const result = await callLocalService(config, "ui." + args[1], port === undefined ? {} : { port: Number(port) }) as Record<string, unknown>;
  if (args[1] === "open" && !args.includes("--json") && !args.includes("--no-browser") && process.platform === "darwin") {
   const browser = Bun.spawn(["/usr/bin/open", String(result.url)], { stdout: "ignore", stderr: "ignore" });
   result.browserOpened = await browser.exited === 0;
  }
  success(command, result);
  return;
 }

 if (command === "devices") {
  const action = args[1];
  if (!["peers", "preview", "enable", "status", "disable"].includes(action ?? "")) throw new Error("usage: devices peers|status|preview|enable|disable [--input <json>] [--preview]");
  rejectUnknownFlags(args.slice(2), ["--input", "--preview", "--json", "--config"]);
  rejectUnexpectedArguments(args.slice(2), ["--input", "--config"]);
  if (args.includes("--preview") && action !== "disable") throw new Error("--preview is supported only by devices disable");
  const raw = option(args, "--input");
  if (["preview", "enable"].includes(action) !== (raw !== undefined)) throw new Error("devices preview and enable require --input; other device commands do not accept --input");
  const input = raw === undefined ? action === "disable" ? { preview: args.includes("--preview") } : {} : JSON.parse(raw);
  success(command, await callLocalService(config, "devices." + action, input));
  return;
 }

	if (command === "service") {
		const subcommand = args[1];
		if (["install", "preview", "installation-status", "uninstall"].includes(subcommand ?? "")) {
			rejectUnknownFlags(args.slice(2), ["--repo", "--store", "--binary", "--config", "--json", "--preview"]);
			if (subcommand === "uninstall") { success(command, await (args.includes("--preview") ? previewServiceRemoval(config) : uninstallService(config))); return; }
			if (args.includes("--preview")) throw new Error("--preview is supported by service uninstall; use service preview to preview installation");
			if (subcommand === "installation-status") { success(command, await serviceInstallationStatus(config)); return; }
			const repositoryRoot = option(args, "--repo") ?? selectedCanonicalRuntime?.repositoryRoot;
			if (!repositoryRoot || !configPath) throw new Error("service installation requires --repo <brain> and --config <path>");
			const installedBinary = option(args, "--binary") ?? process.execPath;
			if (subcommand === "install" && (!isCompiledExecutable(Bun.main) || installedBinary !== process.execPath)) throw new Error("service installation must be run by the installed release binary; preview accepts --binary");
			const target = { installedBinary, configPath, repositoryRoot, storePath: option(args, "--store") };
			success(command, await (subcommand === "preview" ? previewServiceInstallation(config, target) : installService(config, target)));
			return;
		}
		if (subcommand === "status" || subcommand === "stop") {
			success(command, await callLocalService(config, "service." + subcommand, {}, { timeoutMs: 2_000 }));
			return;
		}
		if (subcommand !== "start") throw new Error("usage: service start --repo <brain> [--store <state-directory>] | status | stop");
		const repositoryRoot = option(args, "--repo") ?? process.env.MANAS_BRAIN_REPOSITORY ?? selectedCanonicalRuntime?.repositoryRoot;
		if (!repositoryRoot) throw new Error("service start requires --repo <brain>");
		let stop!: () => void;
		const stopped = new Promise<void>((done) => { stop = done; });
		const service = await startLocalService({ config, repositoryRoot, storePath: option(args, "--store") ?? resolve(config.stateRoot, "runtime"), onStop: stop, onWorkerError: (error) => console.error("Manas worker:", errorMessage(error)) });
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		try {
			success(command, { running: true, repositoryRoot: service.engine.repository.root });
			await stopped;
		} finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); await service.close(); }
		return;
	}

	if (command === "backup") {
		const mode = args[1];
		if (!["create", "verify", "restore"].includes(mode ?? "")) throw new Error("usage: backup create --repo <brain> --store <store> --to <new-directory> | verify --from <backup> | restore --from <backup> --to <new-directory>");
		rejectUnknownFlags(args.slice(2), ["--repo", "--store", "--to", "--from", "--json"]);
		rejectUnexpectedArguments(args.slice(2), ["--repo", "--store", "--to", "--from"]);
		const input = mode === "create"
			? { repositoryRoot: option(args, "--repo") ?? selectedCanonicalRuntime?.repositoryRoot, storePath: option(args, "--store") ?? selectedCanonicalRuntime?.storePath ?? resolve(config.stateRoot, "runtime"), destination: option(args, "--to") }
			: { backupPath: option(args, "--from"), ...(mode === "restore" ? { destination: option(args, "--to") } : {}) };
		if (Object.values(input).some((value) => !value)) throw new Error("backup requires explicit source and destination paths");
		const definition = runtimeBackupOperations(config).find((entry) => entry.name === "backup." + mode)!;
		const registry = new operationRegistryModule.OperationRegistry(); registry.register(definition);
		success(command, await registry.execute({ scope: "admin", principal: "owner", tenantId: "local" }, definition.name, input));
		return;
	}

	if (["remember", "recall", "correct", "forget"].includes(command)) {
		success(command, await executeCatalogCommand("memory", [command, ...args.slice(1)], config));
		return;
	}
	if (command === "migration") {
		const subcommand = args[1];
		rejectUnknownFlags(args.slice(2), ["--from", "--repo", "--id", "--queries", "--expected-head", "--accept-shadow-differences"]);
		if (subcommand === "preview") {
			const source = option(args, "--from"), target = option(args, "--repo");
			if (!source || !target) throw new Error("usage: migration preview --from <archive> --repo <new-brain>");
			success(command, await previewArchiveMigration(source, target, config.stateRoot));
		} else if (subcommand === "rollback") {
			success(command, await rollbackCanonicalArchive(config));
		} else {
			const id = option(args, "--id");
			if (!id || !["resume", "status", "shadow", "activate"].includes(subcommand)) throw new Error("usage: migration resume|status|shadow|activate --id <receipt-id>");
			if (subcommand === "shadow") {
				const queries = JSON.parse(option(args, "--queries") ?? "[]");
				if (!Array.isArray(queries) || queries.some((query) => typeof query !== "string")) throw new Error("--queries must be a JSON array of strings");
				success(command, await shadowArchiveMigration(config, id, queries));
			} else if (subcommand === "activate") {
				const commit = option(args, "--expected-head");
				if (!commit) throw new Error("migration activate requires --expected-head <verified-commit>");
				success(command, await activateCanonicalArchive(config, id, commit, args.includes("--accept-shadow-differences")));
			} else success(command, subcommand === "resume" ? await applyArchiveMigration(config.stateRoot, id) : await readArchiveMigration(config.stateRoot, id));
		}
		return;
	}
 const legacyJobsCommand = command === "jobs" && (!CATALOG_COMMANDS.jobs?.[args[1] ?? ""] || !args.includes("--input") && ["list", "schedules", "cancel"].includes(args[1] ?? ""));

	if (command === "operation" || (CATALOG_COMMANDS[command] && !legacyJobsCommand)) {
		rejectUnknownFlags(args.slice(1), ["--input", "--repo", "--store", "--tenant", "--brain", "--scope", "--mcp-url", "--mcp-token"]);
		success(command, await executeCatalogCommand(command, args.slice(1), config));
		return;
	}
	if (command === "capture") {
		rejectUnknownFlags(args.slice(1), ["--file", "--stdin", "--repo", "--store"]);
		const file = option(args, "--file");
		const stdin = args.includes("--stdin");
		const positional = args.slice(1).filter((value, index, values) => !value.startsWith("--") && values[index - 1] !== "--file" && values[index - 1] !== "--repo" && values[index - 1] !== "--store");
		if ((file ? 1 : 0) + (stdin ? 1 : 0) > 1 || ((file || stdin) && positional.length) || (!file && !stdin && !positional.length)) throw new Error("usage: capture <markdown> | capture --file <path> | capture --stdin");
		const content = file ? await Bun.file(file).text() : stdin ? await Bun.stdin.text() : positional.join(" ");
		success(command, await executeCatalogCommand("operation", ["notes.capture", "--input", JSON.stringify({ content }), ...args.slice(1)], config));
		return;
	}
	if (command === "brain") {
		const subcommand = args[1];
		rejectUnknownFlags(args.slice(2), ["--repo", "--store", "--query", "--semantic", "--expand", "--embedding-endpoint", "--embedding-model", "--embedding-dimensions", "--reranker-endpoint", "--reranker-model", "--allow-hosted-model", "--source-path", "--source-id", "--file", "--format", "--path", "--content", "--expected-revision", "--expected-head", "--from", "--to", "--id", "--include-deleted", "--ref", "--limit", "--depth", "--retention-days", "--confirm-purge", "--schema-id", "--schema-version", "--schema-file", "--list-packs", "--candidates", "--labels", "--mcp-url", "--mcp-token"]);
		if (option(args, "--mcp-url")) { success(command, await remoteBrainOperation(subcommand, args)); return; }
        const executeBrainOperation = (name: string, input: Record<string, unknown>) => executeCatalogCommand("operation", [name, "--input", JSON.stringify(input), ...args.slice(2)], config);
        if (subcommand === "extract") {
            const file = option(args, "--file");
            if (!file) throw new Error("usage: brain extract --file <path>");
            success(command, await executeBrainOperation("runtime.extract", { path: resolve(file) }));
            return;
        }
        const repository = brainRepository(args);
        if (subcommand === "doctor") {
            const result = await executeBrainOperation("runtime.doctor", {}) as { ok: boolean };
            success(command, result);
            if (!result.ok) process.exitCode = 1;
            return;
        }
        if (subcommand === "init") {
            success(command, await executeBrainOperation("runtime.init", {}));
            return;
        }
		if (subcommand === "status") {
			success(command, await executeBrainOperation("brain_status", {}));
			return;
		}
		if (subcommand === "verify") {
			const result = await executeBrainOperation("runtime.verify", { ref: option(args, "--ref") }) as { valid: boolean; issues: string[] };
			if (!result.valid) throw new Error(`brain repository verification failed: ${result.issues.join("; ")}`);
			success(command, result);
			return;
		}
		if (subcommand === "repair") {
			success(command, await executeBrainOperation("repair_brain", { expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "history") {
			const path = option(args, "--path");
			if (!path) throw new Error("usage: brain history --path <path> [--limit <1-500>]");
			const limit = Number(option(args, "--limit") ?? "50");
			success(command, await executeBrainOperation("page_history", { path, limit }));
			return;
		}
		if (subcommand === "revert") {
			const path = option(args, "--path");
			const ref = option(args, "--ref");
			const expected = option(args, "--expected-revision");
			if (!path || !ref || !expected) throw new Error("usage: brain revert --path <path> --ref <commit> --expected-revision <revision>");
			success(command, await executeBrainOperation("revert_page", { path, ref, expectedRevision: expected, expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "schema") {
			const id = option(args, "--schema-id");
			const version = option(args, "--schema-version");
			const schemaFile = option(args, "--schema-file");
			if (args.includes("--list-packs")) {
				if (id || version || schemaFile || args.includes("--candidates")) throw new Error("schema list cannot be combined with another schema action");
				success(command, await executeBrainOperation("list_schema_packs", {}));
				return;
			}
			if (schemaFile) {
				if (id || version || args.includes("--candidates")) throw new Error("schema file cannot be combined with another schema action");
				success(command, await executeBrainOperation("install_schema_pack", { pack: JSON.parse(await Bun.file(schemaFile).text()), expectedHead: option(args, "--expected-head") }));
				return;
			}
			if (args.includes("--candidates")) {
				if (id || version) throw new Error("schema candidates cannot be activated in the same command");
				success(command, await executeBrainOperation("runtime.schema-candidates", {}));
				return;
			}
			if (!id && !version) { success(command, await executeBrainOperation("get_schema", {})); return; }
			if (!id || !version) throw new Error("usage: brain schema --schema-id <id> --schema-version <version> --repo <path>");
			success(command, await executeBrainOperation("set_schema_pack", { id, version, expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "access") {
			const path = option(args, "--path");
			const labels = option(args, "--labels");
			const expected = option(args, "--expected-revision");
			if (!path || labels === undefined || !expected) throw new Error("usage: brain access --path <path> --labels <comma-separated-labels> --expected-revision <revision>");
			success(command, await executeBrainOperation("set_page_access_labels", { path, labels: labels ? labels.split(",") : [], expectedRevision: expected, expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "migrate") {
			const from = option(args, "--from");
			if (!from) throw new Error("usage: brain migrate --from <legacy-archive> --repo <path>");
			success(command, await migrateLegacyArchive(from, repository, { stateRoot: config.stateRoot, receiptId: option(args, "--id") }));
			return;
		}
        if (subcommand === "index") {
            success(command, await executeCatalogCommand("operation", ["projection.rebuild", ...args.slice(1)], config));
            return;
        }
        if (subcommand === "search") {
            const query = option(args, "--query");
            if (!query) throw new Error("usage: brain search --query <query> [--store <pglite-directory>]");
            success(command, await executeBrainOperation("retrieval.search", { query, expand: args.includes("--expand"), rerank: args.includes("--reranker-endpoint") || args.includes("--reranker-model"), options: { mode: args.includes("--semantic") ? "semantic" : "keyword" } }));
            return;
        }
        if (subcommand === "embed") {
            success(command, await executeBrainOperation("projection.embed", {}));
            return;
        }
        if (subcommand === "related") {
            const path = option(args, "--path");
            if (!path) throw new Error("usage: brain related --path <path> [--store <pglite-directory>]");
            success(command, await executeBrainOperation("retrieval.traverse", { path, depth: Number(option(args, "--depth") ?? "1") }));
            return;
        }
        if (subcommand === "sources-list") {
            success(command, await executeBrainOperation("runtime.source-inventory", {}));
            return;
        }
		if (subcommand === "sources-sync") {
			const sourcePath = option(args, "--source-path");
			if (!sourcePath) throw new Error("usage: brain sources-sync --source-path <directory> [--source-id <id>] --repo <path>");
            success(command, await executeBrainOperation("sources.filesystem.sync", { path: resolve(sourcePath), sourceId: option(args, "--source-id") ?? "filesystem" }));
			return;
		}
		if (subcommand === "export") {
			const ref = option(args, "--ref");
			success(command, await executeBrainOperation("export_brain", { ...(ref ? { ref } : {}), includeDeleted: args.includes("--include-deleted") }));
			return;
		}
		if (subcommand === "import") {
			const file = option(args, "--file");
			const format = option(args, "--format");
			if (!file || !format || !["eml", "mbox", "ics", "meeting"].includes(format)) throw new Error("usage: brain import --file <path> --format eml|mbox|ics|meeting --repo <path>");
            success(command, await executeBrainOperation("sources.local.import", { path: resolve(file), format, sourceId: option(args, "--source-id") ?? "local-import:" + format }));
			return;
		}
		if (subcommand === "list") {
			success(command, await executeBrainOperation("list_pages", { includeDeleted: args.includes("--include-deleted") }));
			return;
		}
		const path = option(args, "--path");
		if (subcommand === "get") {
			if (!path) throw new Error("usage: brain get --path <path>");
			const ref = option(args, "--ref");
			try { success(command, await executeBrainOperation(ref ? "get_page_at" : "get_page", ref ? { path, ref } : { path, includeDeleted: args.includes("--include-deleted") })); }
			catch (error) { if (error instanceof Error && error.message === "invalid params") throw new Error("brain page not found"); throw error; }
			return;
		}
		if (subcommand === "put") {
			const content = option(args, "--content");
			if (!path || content === undefined) throw new Error("usage: brain put --path <path> --content <markdown>");
			const expectedRevision = option(args, "--expected-revision");
			let expectedHead = option(args, "--expected-head");
			if (expectedHead === undefined) {
				const status = await executeBrainOperation("brain_status", {}) as { head?: string; pages: { active: number; deleted: number } };
				// Keep first-create compatibility after the empty runtime bootstrap.
				// The write still compares this exact head, including concurrent changes.
				if (status.pages.active === 0 && status.pages.deleted === 0) expectedHead = status.head;
			}
			success(command, await executeBrainOperation("put_page", { path, content, ...(expectedRevision ? { expectedRevision } : {}), expectedHead: expectedHead ?? null }));
			return;
		}
		if (subcommand === "move") {
			const from = option(args, "--from");
			const to = option(args, "--to");
			const expected = option(args, "--expected-revision");
			if (!from || !to || !expected) throw new Error("usage: brain move --from <path> --to <path> --expected-revision <revision>");
			success(command, await executeBrainOperation("move_page", { from, to, expectedRevision: expected, expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "delete") {
			const expected = option(args, "--expected-revision");
			if (!path || !expected) throw new Error("usage: brain delete --path <path> --expected-revision <revision>");
			success(command, await executeBrainOperation("delete_page", { path, expectedRevision: expected, expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "restore") {
			const id = option(args, "--id");
			const expected = option(args, "--expected-revision");
			if (!id || !path || !expected) throw new Error("usage: brain restore --id <id> --path <path> --expected-revision <revision>");
			success(command, await executeBrainOperation("restore_page", { id, path, expectedRevision: expected, expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "purge") {
			const id = option(args, "--id");
			if (!args.includes("--confirm-purge") || !id) throw new Error("usage: brain purge --id <deleted-page-id> --confirm-purge --expected-head <git-commit>");
			const retentionDays = option(args, "--retention-days");
			success(command, await executeBrainOperation("purge_deleted_page", { id, expectedHead: option(args, "--expected-head"), ...(retentionDays ? { retentionDays: Number(retentionDays) } : {}) }));
			return;
		}
		throw new Error("usage: brain init|migrate|verify|doctor|repair|history|revert|status|schema|access|index|embed|search|related|sources-list|sources-sync|import|extract|export|list|get|put|move|delete|restore|purge");
	}
	if (command === "sync") {
		rejectUnknownFlags(args.slice(1), ["--provider", "--dry-run", "--scheduled"]);
		const scheduled = args.includes("--scheduled");
		if (scheduled && !isCompiledExecutable(Bun.main))
			throw new Error("scheduled sync requires an installed release binary");
		const startedAt = new Date().toISOString();
		const runId = crypto.randomUUID();
		try {
			const result = await runSync(config, {
				provider: providerOption(args),
				dryRun: args.includes("--dry-run"),
			});
			success(command, {
				dryRun: result.dryRun,
				totals: result.report.totals,
				changes: result.changes.length,
			});
			if (scheduled) await writeScheduledSyncReceipt(config.stateRoot, {
				runId,
				executable: process.execPath,
				configPath: configPath ?? "",
				startedAt,
				finishedAt: new Date().toISOString(),
				status: result.report.failures.length ? "failed" : "success",
				report: result.report,
			});
			if (result.report.failures.length) process.exitCode = 1;
			return;
		} catch (error) {
			if (scheduled) await writeScheduledSyncReceipt(config.stateRoot, {
				runId,
				executable: process.execPath,
				configPath: configPath ?? "",
				startedAt,
				finishedAt: new Date().toISOString(),
				status: "failed",
				report: { error: error instanceof Error ? error.message : "scheduled sync failed" },
			});
			throw error;
		}
	}
	if (command === "import") {
		const provider = args[1];
		const path = args[2];
		if ((provider !== "chatgpt" && provider !== "claude") || !path)
			throw new Error("usage: import chatgpt|claude <zip-or-json>");
		const imported = await importOfficialExport(provider, path);
		const result = await runSync(config, {
			conversations: imported.conversations,
			scanned: imported.conversations.length,
			extraWarnings: imported.warnings.map((message) => ({
				provider,
				sourcePath: path,
				message,
			})),
		});
		success(command, {
			provider,
			imported: imported.conversations.length,
			totals: result.report.totals,
		});
		if (result.report.failures.length) process.exitCode = 1;
		return;
	}
	if (command === "verify") {
		requireNoArguments(command, args.slice(1));
		const result = await verifyArchive(config.archiveRoot);
		const scan = await scanArchive(config.archiveRoot);
		const local = await discoverLocalSources();
		const sourceErrors = [
			...local.failures.map(
				(failure) => `[${failure.provider}] ${failure.message}`,
			),
		];
		const eligible = local.conversations;
		let mapped = 0;
		for (const conversation of eligible) {
			if (
				scan.bySource.has(`${conversation.provider}\0${conversation.sourceId}`)
			)
				mapped += 1;
			else
				sourceErrors.push(
					`[${conversation.provider}] eligible source is not mapped: ${conversation.sourceId}`,
				);
		}
		const output = {
			...result,
			ok: result.ok && sourceErrors.length === 0,
			errors: [...result.errors, ...sourceErrors],
			sources: {
				scanned: local.results.reduce((sum, item) => sum + item.scanned, 0),
				eligible: eligible.length,
				mapped,
			},
		};
		success(command, output);
		if (!output.ok) process.exitCode = 1;
		return;
	}
	if (command === "install") {
		requireNoArguments(command, args.slice(1));
		if (!isCompiledExecutable(Bun.main))
			throw new Error("self-install requires an installed release binary");
		const result = await installCompiledBinary({
			source: process.execPath,
			destination: resolve(homedir(), ".local", "bin", "manas"),
			version: MANAS_VERSION,
		});
		success(command, result);
		return;
	}
	if (command === "install-launch-agent") {
		requireNoArguments(command, args.slice(1));
		if (!isCompiledExecutable(Bun.main))
			throw new Error("scheduling requires an installed release binary; source execution supports --no-schedule only");
		if (!configPath) throw new Error("install-launch-agent requires --config <path>");
		const path = await installLaunchAgent(config, { installedBinary: process.execPath, configPath });
		success(command, { installed: true, path });
		return;
	}
	if (command === "migrate-identifiers") {
		rejectUnknownFlags(args.slice(1), ["--preview", "--yes", "--json"]);
		if (args.includes("--preview") && args.includes("--yes"))
			throw new Error("choose either --preview or --yes");
		success(command, await migrateIdentifiers(config, args.includes("--yes")));
		return;
	}
	if (command === "status" || command === "sync-status") {
		requireNoArguments(command, args.slice(1));
		success(command, await statusService(config));
		return;
	}
	if (command === "index") {
		rejectUnknownFlags(args.slice(1), ["--rebuild", "--repair"]);
		if (args.includes("--rebuild") && args.includes("--repair"))
			throw new Error("choose either --rebuild or --repair");
        if (selectedCanonicalRuntime) {
            success(command, await executeCatalogCommand("operation", ["projection.rebuild"], config));
            return;
        }
		if (args.includes("--repair")) {
			const brain = config.brain;
			if (!brain) throw new Error("brain configuration is unavailable");
			const database = await openBrainDatabase(brain.databasePath);
			try {
				assertBrainIntegrity(database);
			} finally {
				database.close();
			}
		}
		const result = await indexArchive(config, args.includes("--rebuild"));
		success(command, result);
		return;
	}
	if (command === "search") {
		rejectUnknownFlags(args.slice(2), [
			"--limit",
			"--keyword-only",
			"--semantic-only",
			"--explain",
			"--provider",
			"--project",
			"--repository",
			"--workspace",
			"--role",
			"--after",
			"--before",
		]);
		const query = args[1];
		if (!query || query.startsWith("--"))
			throw new Error("usage: search <query>");
		const rawLimit = option(args, "--limit");
		const mode: SearchMode = args.includes("--keyword-only")
			? "keyword"
			: args.includes("--semantic-only")
				? "semantic"
				: "hybrid";
		if (args.includes("--keyword-only") && args.includes("--semantic-only"))
			throw new Error("choose either --keyword-only or --semantic-only");
		const outcome = await searchService(config, query, {
			limit: rawLimit ? Number(rawLimit) : undefined,
			mode,
			explain: args.includes("--explain"),
			provider: option(args, "--provider"),
			project: option(args, "--project"),
			repository: option(args, "--repository"),
			workspace: option(args, "--workspace"),
			role: option(args, "--role") as "user" | "assistant" | undefined,
			after: option(args, "--after"),
			before: option(args, "--before"),
		});
		success(command, { query, ...outcome });
		if (outcome.degraded) process.exitCode = 2;
		return;
	}
	if (command === "think") {
		if (args.slice(1).some((value) => value.startsWith("--")))
			throw new Error("think does not accept options");
		const question = args.slice(1).join(" ");
		if (!question) throw new Error("usage: think <question>");
		const result = await thinkService(config, question);
		success(command, result);
		if (result.outcome !== "answered") process.exitCode = 2;
		return;
	}
	if (command === "get") {
		const manasId = args[1];
		if (!manasId) throw new Error("usage: get <manas-id>");
		if (args.length !== 2) throw new Error("usage: get <manas-id>");
		success(command, await getService(config, manasId));
		return;
	}
	if (command === "related") {
		const manasId = args[1];
		if (!manasId) throw new Error("usage: related <manas-id>");
		if (args.length !== 2) throw new Error("usage: related <manas-id>");
		success(command, await relatedService(config, manasId));
		return;
	}
	if (command === "health" || command === "doctor") {
		requireNoArguments(command, args.slice(1));
		const health = await healthService(config);
		success(command, health);
		if (!health.ok) process.exitCode = 1;
		return;
	}
    if (command === "jobs") {
        const subcommand = args[1];
        rejectUnknownFlags(args.slice(2), ["--store", "--limit", "--repo", "--id", "--at", "--every-seconds", "--tenant"]);
        const execute = (name: string, input: Record<string, unknown>) => executeCatalogCommand("operation", [name, "--input", JSON.stringify(input), ...args.slice(2)], config);
        if (subcommand === "list") { success(command, { jobs: await execute("jobs.list", { limit: Number(option(args, "--limit") ?? "100") }) }); return; }
        if (subcommand === "schedules") { success(command, { schedules: await execute("jobs.schedules", {}) }); return; }
        if (subcommand === "cancel") {
            const id = option(args, "--id");
            if (!id) throw new Error("jobs cancel requires --id <job-id>");
            await execute("jobs.cancel", { id });
            success(command, { cancelled: id }); return;
        }
        const root = brainRepository(args).root;
        if (subcommand === "enqueue-index") {
            success(command, { job: await execute("jobs.enqueue", { type: "index", payload: { repositoryRoot: root }, availableAt: scheduledAt(args)?.toISOString() }) }); return;
        }
        if (subcommand === "schedule-index") {
            const intervalSeconds = Number(option(args, "--every-seconds"));
            if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) throw new Error("jobs schedule-index requires --every-seconds <positive-integer>");
            success(command, { schedule: await execute("jobs.schedule", { type: "index", payload: { repositoryRoot: root }, intervalSeconds, nextRunAt: scheduledAt(args)?.toISOString() }) }); return;
        }
        throw new Error("usage: jobs list|enqueue-index|schedule-index|schedules|run-one|cancel [--store <directory>] [--repo <brain>]");
    }
    if (command === "auth") {
        const subcommand = args[1];
        rejectUnknownFlags(args.slice(2), ["--store", "--name", "--scopes", "--id", "--user-id", "--expires-at", "--tenant", "--limit", "--repo"]);
        const execute = (name: string, input: Record<string, unknown>) => executeCatalogCommand("operation", [name, "--input", JSON.stringify(input), ...args.slice(2)], config);
        if (subcommand === "list") { success(command, { tokens: await execute("admin.token.list", {}) }); return; }
        if (subcommand === "events") { success(command, { events: await execute("admin.audit", { limit: Number(option(args, "--limit") ?? "100") }) }); return; }
        if (subcommand === "revoke") {
            const id = option(args, "--id");
            if (!id) throw new Error("auth revoke requires --id <token-id>");
            await execute("admin.token.revoke", { id, confirmation: "admin.token.revoke " + id, idempotencyKey: "cli-token-revoke:" + id });
            success(command, { revoked: id }); return;
        }
        if (subcommand === "create") {
            const name = option(args, "--name"), scopes = option(args, "--scopes");
            if (!name || !scopes) throw new Error("auth create requires --name <name> --scopes <read,write,admin>");
            success(command, await execute("admin.token.create", { name, scopes: scopes.split(","), userId: option(args, "--user-id"), expiresAt: option(args, "--expires-at") })); return;
        }
        throw new Error("usage: auth create|list|events|revoke [--store <directory>]");
    }
	if (command === "serve") {
		rejectUnknownFlags(args.slice(1), ["--http-port", "--store", "--scope", "--visibility", "--client"]);
		const clientId = option(args, "--client");
		const clientScope = option(args, "--scope");
		if (clientId && (clientScope || option(args, "--visibility"))) throw new Error("--client uses its owner-managed grant; omit --scope and --visibility");
		if (clientScope !== undefined && !["read", "write"].includes(clientScope)) throw new Error("client --scope must be read or write");
		const clientLabels: unknown = JSON.parse(option(args, "--visibility") ?? "[]");
		if (!Array.isArray(clientLabels) || clientLabels.some((label) => typeof label !== "string" || !label.trim())) throw new Error("--visibility must be a JSON array of labels");
		if (option(args, "--visibility") && !clientScope) throw new Error("--visibility requires --scope");
		const rawPort = option(args, "--http-port");
		if (rawPort) {
			if (clientScope || clientId) throw new Error("--scope and --client are for stdio clients; HTTP clients use access tokens");
			const port = Number(rawPort);
			const token = process.env.MANAS_MCP_TOKEN;
			if (!token) throw new Error("MANAS_MCP_TOKEN is required for HTTP MCP");
			const storePath = option(args, "--store") ?? selectedCanonicalRuntime?.storePath;
			const remoteRoot = process.env.MANAS_BRAIN_REPOSITORY ?? selectedCanonicalRuntime?.repositoryRoot;
			let proxyRegistry;
			try { proxyRegistry = await localServiceRegistry(config, remoteRoot); }
			catch (error) { if (!(error instanceof LocalServiceError) || error.code !== "service_unavailable") throw error; }
			if (proxyRegistry) {
				serveMcpHttp(config, {
					port, token, scopes: mcpScopes(), operationRegistry: proxyRegistry,
					authorizeToken: async (candidate, scope, tenantId) => await callLocalService(config, "service.authorize-token", { token: candidate, scope, tenantId }) as boolean,
					principalForToken: async (candidate) => await callLocalService(config, "service.identify-token", { token: candidate }) as { id: string; tenantId: string; userId?: string } | undefined,
					authorizeOperation: async (principal, definition, input) => await callLocalService(config, "service.authorize-operation", { principal, name: definition.name, input }) as { allowedAccessLabels?: string[] },
				});
				await new Promise<void>(() => undefined);
			}
			const engine = remoteRoot ? await createBrainEngine({ repositoryRoot: remoteRoot, storePath, config }) : undefined;
			const store = engine?.store ?? (storePath ? await openPgliteBrainStore(storePath) : undefined);
			const operationRegistry = engine?.operations;
		serveMcpHttp(config, { port, token, scopes: mcpScopes(), authorizeToken: store ? (candidate: string, scope: "read" | "write" | "admin", tenantId?: string) => authorizePersonalAccessToken(store, candidate, scope, tenantId ?? "local") : undefined, principalForToken: store ? (candidate: string) => identifyPersonalAccessToken(store, candidate) : undefined, authorizeOperation: store ? hostedOperationAuthorizer(store) : undefined, operationRegistry });
			await new Promise<void>(() => undefined);
		}
		const storePath = option(args, "--store") ?? selectedCanonicalRuntime?.storePath;
		const localRoot = process.env.MANAS_BRAIN_REPOSITORY ?? selectedCanonicalRuntime?.repositoryRoot;
		let operationRegistry;
		try { operationRegistry = await localServiceRegistry(config, localRoot); }
		catch (error) { if (!(error instanceof LocalServiceError) || error.code !== "service_unavailable") throw error; }
		const engine = !operationRegistry && localRoot ? await createBrainEngine({ repositoryRoot: localRoot, storePath, config }) : undefined;
		operationRegistry ??= engine?.operations;
		const store = !operationRegistry && storePath ? await openPgliteBrainStore(storePath) : undefined;
        try {
        if (clientId) {
            if (!operationRegistry) throw new Error("managed clients require the canonical operation registry");
            operationRegistry = await liveClientRegistry(operationRegistry, config.stateRoot, clientId);
        }
		if (clientScope) {
			if (!operationRegistry) throw new Error("scoped clients require the canonical operation registry");
			operationRegistry = operationRegistryModule.scopedClientRegistry(operationRegistry, { scope: clientScope as "read" | "write", principal: "stdio-client", tenantId: "local", allowedAccessLabels: clientLabels as string[] });
		}
		await serveMcp(config, { operationRegistry, catalogOnly: Boolean(clientScope || clientId) }); }
		finally { await engine?.close(); await store?.close(); }
		return;
	}
	throw new Error(`unknown command: ${command}`);
}

try {
	await main();
} catch (error) {
	if (invokedCommand !== "serve") failure(invokedCommand, error);
	if (invokedCommand !== "setup") process.exitCode = 1;
}
