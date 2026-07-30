#!/usr/bin/env bun

import { importOfficialExport } from "./imports/exports";
import { loadConfig } from "./config";
import { installLaunchAgent } from "./launch-agent";
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
import { homedir } from "node:os";
import { resolve } from "node:path";
import { installCompiledBinary } from "@manas/installer";
import { isCompiledExecutable } from "@manas/executable";

import { writeScheduledSyncReceipt } from "@manas/scheduler-receipt";

import { BrainRepository } from "./brain/repository";
import { migrateLegacyArchive, preflightChatHistorySyncMigration } from "./migration";
import { openPgliteBrainStore } from "./brain/store";
import { indexBrainRepository, relatedBrainPages, rerankProjectedSearchResults, resolveBrainCitation, searchBrainRepository, searchExpandedBrainRepository, searchVerifiedHybridBrainRepository, traverseBrainGraph } from "./brain/pglite-indexer";
import { FilesystemSourceAdapter } from "./sources/filesystem";
import { syncSource } from "./sources/sync";
import * as genericImportModule from "./sources/generic-imports";
import { captureBrainNote } from "./brain/capture";
import { OpenAiCompatibleEmbeddingProvider, OpenAiCompatibleRerankerProvider, OpenAiCompatibleStructuredExtractionProvider, OpenAiCompatibleTranscriptionProvider } from "./brain/providers";
import { indexLocalEmbeddings } from "./brain/local-embeddings";
import { loadState, saveState } from "./state";
import * as operationRegistryModule from "./brain/operation-registry";
import * as operationCatalogModule from "./brain/operation-catalog";
import * as controlPlaneModule from "./brain/control-plane";
import { serveMcpHttp } from "./mcp/http";
import { callMcpHttp } from "./mcp/client";
import { extractLocalFile } from "./sources/extractors";
import { diagnoseBrain } from "./brain/diagnostics";
import { authorizePersonalAccessToken, createPersonalAccessToken, identifyPersonalAccessToken, listPersonalAccessTokens, revokePersonalAccessToken } from "./brain/access-tokens";
import { listAuditEvents } from "./brain/audit";
import { redactAdminEvent } from "./brain/control-plane";
import { cancelJob, createJobSchedule, enqueueJob, listJobSchedules, listJobs, runOneJob } from "./brain/jobs";
import { createParityJobHandlers } from "./brain/job-handlers";
import { detectSchemaPack } from "./brain/schema";
import { SqlTenantDirectory } from "./brain/tenancy";
import { setupManas, setupJsonDocument } from "./setup";

const LOCAL_PROVIDERS: Provider[] = [
	"claude_code",
	"codex",
	"pi",
	"cursor",
	"grok",
];


const brainOperationModule = {
	executeBrainRepositoryOperation: (repository: unknown, name: string, args: Record<string, unknown>) => operationRegistryModule.createBrainRepositoryOperationRegistry(repository as never).execute({ scope: "admin", principal: "cli" }, name, args),
};

const CATALOG_COMMANDS: Record<string, Record<string, string>> = {
	models: { diagnose: "models.diagnose", activate: "models.activate" },
	agents: { start: "agent.start", status: "agent.status", update: "agent.update" },
	autopilot: { start: "agent.start", status: "agent.status", update: "agent.update" },
	jobs: { list: "jobs.list", enqueue: "jobs.enqueue", cancel: "jobs.cancel", schedule: "jobs.schedule", schedules: "jobs.schedules" },
	dream: { run: "jobs.enqueue", maintenance: "maintenance.propose" },
	maintenance: { propose: "maintenance.propose" },
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

async function executeCatalogCommand(command: string, args: string[]): Promise<unknown> {
	const operation = command === "operation" ? args[0] : CATALOG_COMMANDS[command]?.[args[0] ?? ""];
	if (!operation) throw new Error(`usage: ${command} <operation> --input <json> --repo <path> [--store <pglite-directory>]`);
	const inputText = option(args, "--input");
	let input: Record<string, unknown> = {};
	if (inputText) {
		const parsed = JSON.parse(inputText) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--input must be a JSON object");
		input = parsed as Record<string, unknown>;
	}
	const remoteUrl = option(args, "--mcp-url");
	if (remoteUrl) {
		const token = option(args, "--mcp-token") ?? process.env.MANAS_MCP_TOKEN;
		if (!token) throw new Error("both --mcp-url and --mcp-token (or MANAS_MCP_TOKEN) are required");
		return callMcpHttp(remoteUrl, token, operation, input);
	}
	const storePath = option(args, "--store");
	const repository = option(args, "--repo") ? brainRepository(args) : new BrainRepository(storePath ?? ".");
	const store = storePath ? await openPgliteBrainStore(storePath) : undefined;
	try {
		const registry = operationCatalogModule.createFullOperationRegistry({ repository, ...(store ? { store, controlPlane: new controlPlaneModule.DurableControlPlane(store) } : {}) });
		const requestedScope = option(args, "--scope") ?? "admin";
		if (!["read", "write", "admin"].includes(requestedScope)) throw new Error("--scope must be read, write, or admin");
		return await registry.execute({ scope: requestedScope as "read" | "write" | "admin", principal: "cli", tenantId: option(args, "--tenant") ?? "local", ...(option(args, "--brain") ? { brainId: option(args, "--brain") } : {}) }, operation, input);
	} finally { await store?.close(); }
}

function usage(): string {
	return `manas

Commands:
  setup [--archive <path>] [--config <path>] [--yes] [--no-schedule] [--detect-only|--preview|--repair] [--retire-legacy] [--json]
  sync [--config <path>] [--provider <name>] [--dry-run|--scheduled]
  import chatgpt <zip-or-json>
  import claude <zip-or-json>
  install
  verify
  install-launch-agent --config <path>
  status|sync-status [--config <path>]
  migrate-chat-history-sync --config <path>
  index [--rebuild|--repair]
  search <query> [--limit <1-100>] [--keyword-only|--semantic-only]
  think <question>
  get <nessie-id>
  related <nessie-id>
  health
  jobs list|enqueue-index|schedule-index|schedules|run-one|cancel --store <pglite-directory> [--repo <brain-repository>] [--id <job-id>] [--at <ISO-timestamp>] [--every-seconds <seconds>] [--limit <1-1000>]
  serve [--http-port <port>]
  auth create|list|revoke --store <pglite-directory>
  models diagnose|activate, agents, autopilot, dream, maintenance, sources, plugins, schema, upgrade, skills, admin, cache, storage, integrity, anomaly, evaluation, analysis, rollback, connect
	  operation <catalog-operation> --input <json> --repo <path> [--store <pglite-directory>] | --mcp-url <url> --mcp-token <token>
  doctor [--json]
  capture <markdown> | capture --file <path> | capture --stdin
  brain init|migrate|verify|doctor|repair|history|revert|status|schema|access|index|embed|search|related|sources-list|sources-sync|import|extract|export|list|get|put|move|delete|restore --repo <path>`;
}

function brainRepository(args: string[]) {
	const supplied = option(args, "--repo");
	const root = supplied ?? process.env.MANAS_BRAIN_REPOSITORY;
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
	return async (principal: { id: string; tenantId: string; userId?: string }, definition: { requiredScope: "read" | "write" | "admin" }, input: Record<string, unknown>): Promise<void> => {
		if (!principal.userId) return;
		const brainId = typeof input.brainId === "string" ? input.brainId : undefined;
		const labels = Array.isArray(input.labels) ? input.labels.filter((label): label is string => typeof label === "string") : [];
		const authorization = await directory.authorizeWithLabels(principal.userId, principal.tenantId, brainId, definition.requiredScope);
			const allowedAccessLabels = authorization.allowedAccessLabels;
			if (allowedAccessLabels && labels.some((label) => !allowedAccessLabels.includes(label))) throw new Error("scope is not authorized");
		return;
	};
}

function success(command: string, data: unknown): void {
	console.log(JSON.stringify({ ok: true, command, data }, null, 2));
}

function failure(command: string | undefined, error: unknown): void {
	const message = error instanceof Error ? error.message : "request failed";
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

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];
	if (command === "--version" || command === "version") {
		console.log(MANAS_VERSION);
		return;
	}
	const configPath = option(args, "--config");
	const config = await loadConfig({ ...(configPath && command !== "migrate-chat-history-sync" && command !== "setup" ? { filePath: configPath } : {}) });
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
	const legacyJobsCommand = command === "jobs" && !CATALOG_COMMANDS.jobs?.[args[1] ?? ""];
	if (command === "operation" || (CATALOG_COMMANDS[command] && !legacyJobsCommand)) {
		rejectUnknownFlags(args.slice(1), ["--input", "--repo", "--store", "--tenant", "--brain", "--scope", "--mcp-url", "--mcp-token"]);
		success(command, await executeCatalogCommand(command, args.slice(1)));
		return;
	}
	if (command === "capture") {
		rejectUnknownFlags(args.slice(1), ["--file", "--stdin", "--repo"]);
		const file = option(args, "--file");
		const stdin = args.includes("--stdin");
		const positional = args.slice(1).filter((value, index, values) => !value.startsWith("--") && values[index - 1] !== "--file" && values[index - 1] !== "--repo");
		if ((file ? 1 : 0) + (stdin ? 1 : 0) > 1 || ((file || stdin) && positional.length) || (!file && !stdin && !positional.length)) throw new Error("usage: capture <markdown> | capture --file <path> | capture --stdin");
		const content = file ? await Bun.file(file).text() : stdin ? await Bun.stdin.text() : positional.join(" ");
		success(command, await captureBrainNote(brainRepository(args), content));
		return;
	}
	if (command === "brain") {
		const subcommand = args[1];
		rejectUnknownFlags(args.slice(2), ["--repo", "--store", "--query", "--semantic", "--expand", "--embedding-endpoint", "--embedding-model", "--embedding-dimensions", "--reranker-endpoint", "--reranker-model", "--allow-hosted-model", "--source-path", "--source-id", "--file", "--format", "--path", "--content", "--expected-revision", "--expected-head", "--from", "--to", "--id", "--include-deleted", "--ref", "--limit", "--depth", "--retention-days", "--confirm-purge", "--schema-id", "--schema-version", "--schema-file", "--list-packs", "--candidates", "--labels", "--mcp-url", "--mcp-token"]);
		if (option(args, "--mcp-url")) { success(command, await remoteBrainOperation(subcommand, args)); return; }
		if (subcommand === "extract") {
			const file = option(args, "--file");
			if (!file) throw new Error("usage: brain extract --file <path>");
			success(command, await extractLocalFile(file));
			return;
		}
		const repository = brainRepository(args);
		if (subcommand === "doctor") {
			const storePath = option(args, "--store");
			if (!storePath) {
				const result = await diagnoseBrain(repository);
				success(command, result);
				if (!result.ok) process.exitCode = 1;
				return;
			}
			const store = await openPgliteBrainStore(storePath);
			try {
				const result = await diagnoseBrain(repository, store);
				success(command, result);
				if (!result.ok) process.exitCode = 1;
			} finally { await store.close(); }
			return;
		}
		if (subcommand === "init") {
			await repository.initialize();
			success(command, { initialized: true, root: repository.root });
			return;
		}
		if (subcommand === "status") {
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "brain_status", {}));
			return;
		}
		if (subcommand === "verify") {
			const result = await repository.verify(option(args, "--ref"));
			if (!result.valid) throw new Error(`brain repository verification failed: ${result.issues.join("; ")}`);
			success(command, result);
			return;
		}
		if (subcommand === "repair") {
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "repair_brain", { expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "history") {
			const path = option(args, "--path");
			if (!path) throw new Error("usage: brain history --path <path> [--limit <1-500>]");
			const limit = Number(option(args, "--limit") ?? "50");
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "page_history", { path, limit }));
			return;
		}
		if (subcommand === "revert") {
			const path = option(args, "--path");
			const ref = option(args, "--ref");
			const expected = option(args, "--expected-revision");
			if (!path || !ref || !expected) throw new Error("usage: brain revert --path <path> --ref <commit> --expected-revision <revision>");
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "revert_page", { path, ref, expectedRevision: expected, expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "schema") {
			const id = option(args, "--schema-id");
			const version = option(args, "--schema-version");
			const schemaFile = option(args, "--schema-file");
			if (args.includes("--list-packs")) {
				if (id || version || schemaFile || args.includes("--candidates")) throw new Error("schema list cannot be combined with another schema action");
				success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "list_schema_packs", {}));
				return;
			}
			if (schemaFile) {
				if (id || version || args.includes("--candidates")) throw new Error("schema file cannot be combined with another schema action");
				success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "install_schema_pack", { pack: JSON.parse(await Bun.file(schemaFile).text()), expectedHead: option(args, "--expected-head") }));
				return;
			}
			if (args.includes("--candidates")) {
				if (id || version) throw new Error("schema candidates cannot be activated in the same command");
				const pages = await repository.listPages();
				success(command, { candidates: detectSchemaPack(pages.map((page: { path: string }) => page.path)) });
				return;
			}
			if (!id && !version) { success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "get_schema", {})); return; }
			if (!id || !version) throw new Error("usage: brain schema --schema-id <id> --schema-version <version> --repo <path>");
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "set_schema_pack", { id, version, expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "access") {
			const path = option(args, "--path");
			const labels = option(args, "--labels");
			const expected = option(args, "--expected-revision");
			if (!path || labels === undefined || !expected) throw new Error("usage: brain access --path <path> --labels <comma-separated-labels> --expected-revision <revision>");
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "set_page_access_labels", { path, labels: labels ? labels.split(",") : [], expectedRevision: expected, expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "migrate") {
			const from = option(args, "--from");
			if (!from) throw new Error("usage: brain migrate --from <legacy-archive> --repo <path>");
			success(command, await migrateLegacyArchive(from, repository));
			return;
		}
		if (subcommand === "index" || subcommand === "embed" || subcommand === "search") {
			const storePath = option(args, "--store");
			if (!storePath) throw new Error("brain index and search require --store <pglite-directory>");
			const store = await openPgliteBrainStore(storePath);
			try {
				if (subcommand === "index") success(command, await indexBrainRepository(store, repository));
				else if (subcommand === "embed") {
					const endpoint = option(args, "--embedding-endpoint");
					const model = option(args, "--embedding-model");
					const dimensions = Number(option(args, "--embedding-dimensions"));
					if (!endpoint || !model || !Number.isInteger(dimensions) || dimensions < 1) throw new Error("usage: brain embed --store <pglite-directory> --embedding-endpoint <url> --embedding-model <name> --embedding-dimensions <number>");
					success(command, await indexLocalEmbeddings(store, new OpenAiCompatibleEmbeddingProvider({ id: model, dimensions }, endpoint, process.env.MANAS_EMBEDDING_API_KEY, args.includes("--allow-hosted-model") ? "hosted" : "local")));
				}
				else {
					const query = option(args, "--query");
					if (!query) throw new Error("usage: brain search --query <query> --store <pglite-directory>");
						if (args.includes("--semantic")) {
							const endpoint = option(args, "--embedding-endpoint");
							const model = option(args, "--embedding-model");
							const dimensions = Number(option(args, "--embedding-dimensions"));
							if (!endpoint || !model || !Number.isInteger(dimensions) || dimensions < 1) throw new Error("semantic search requires embedding endpoint, model, and dimensions");
							const embeddingProvider = new OpenAiCompatibleEmbeddingProvider({ id: model, dimensions }, endpoint, process.env.MANAS_EMBEDDING_API_KEY, args.includes("--allow-hosted-model") ? "hosted" : "local");
							const rerankerEndpoint = option(args, "--reranker-endpoint");
							const rerankerModel = option(args, "--reranker-model");
							if (Boolean(rerankerEndpoint) !== Boolean(rerankerModel)) throw new Error("reranking requires both --reranker-endpoint and --reranker-model");
							const rerankerProvider = rerankerEndpoint && rerankerModel ? new OpenAiCompatibleRerankerProvider(rerankerModel, rerankerEndpoint, process.env.MANAS_RERANKER_API_KEY, args.includes("--allow-hosted-model") ? "hosted" : "local") : undefined;
							success(command, { results: await searchVerifiedHybridBrainRepository(store, repository, query, { embeddingProvider, ...(rerankerProvider ? { rerankerProvider } : {}), brainId: (await repository.snapshot()).brainId, limit: 20 }) });
					} else {
						const snapshot = await repository.snapshot();
						const expanded = args.includes("--expand") ? await searchExpandedBrainRepository(store, query, 20, snapshot.brainId) : undefined;
						const results = expanded?.results ?? await searchBrainRepository(store, query, 20, snapshot.brainId);
						const rerankerEndpoint = option(args, "--reranker-endpoint");
						const rerankerModel = option(args, "--reranker-model");
						if (Boolean(rerankerEndpoint) !== Boolean(rerankerModel)) throw new Error("reranking requires both --reranker-endpoint and --reranker-model");
						const reranked = rerankerEndpoint && rerankerModel ? await rerankProjectedSearchResults(new OpenAiCompatibleRerankerProvider(rerankerModel, rerankerEndpoint, process.env.MANAS_RERANKER_API_KEY, args.includes("--allow-hosted-model") ? "hosted" : "local"), query, results) : results;
						const verified = await Promise.all((reranked as Array<{ citation: Parameters<typeof resolveBrainCitation>[2] }>).map(async (result) => ({ ...result, verifiedText: (await resolveBrainCitation(store, repository, result.citation)).text })));
						success(command, expanded ? { variants: expanded.variants, results: verified } : { results: verified });
					}
				}
			} finally { await store.close(); }
			return;
		}
		if (subcommand === "related") {
			const path = option(args, "--path");
			const storePath = option(args, "--store");
			if (!path || !storePath) throw new Error("usage: brain related --path <path> --store <pglite-directory>");
			const depth = Number(option(args, "--depth") ?? "1");
			if (!Number.isInteger(depth) || depth < 1 || depth > 5) throw new Error("graph traversal depth must be an integer between 1 and 5");
			const store = await openPgliteBrainStore(storePath);
			try {
				const snapshot = await repository.snapshot();
				success(command, depth === 1 ? { pages: await relatedBrainPages(store, path, snapshot.brainId) } : { pages: await traverseBrainGraph(store, path, snapshot.brainId, depth) });
			} finally { await store.close(); }
			return;
		}
		if (subcommand === "sources-list") {
			const pages = await repository.listPages(true);
			const sources = new Map<string, { id: string; documents: number; stale: number }>();
			for (const page of pages) if (page.source) {
				const value = sources.get(page.source.type) ?? { id: page.source.type, documents: 0, stale: 0 };
				value.documents += 1;
				if (page.stale) value.stale += 1;
				sources.set(page.source.type, value);
			}
			success(command, { sources: [...sources.values()].sort((left, right) => left.id.localeCompare(right.id)) });
			return;
		}
		if (subcommand === "sources-sync") {
			const sourcePath = option(args, "--source-path");
			if (!sourcePath) throw new Error("usage: brain sources-sync --source-path <directory> [--source-id <id>] --repo <path>");
			const adapter = new FilesystemSourceAdapter(sourcePath, option(args, "--source-id") ?? "filesystem");
			const state = await loadState(config.stateRoot);
			const checkpoints = {
				get: async (sourceId: string) => state.sourceCheckpoints?.[sourceId],
				set: async (sourceId: string, checkpoint: { updatedAt?: string }) => { state.sourceCheckpoints = { ...state.sourceCheckpoints, [sourceId]: checkpoint }; },
			};
			const result = await syncSource(adapter, repository, checkpoints);
			const storePath = option(args, "--store");
			if (storePath) {
				const store = await openPgliteBrainStore(storePath);
				try { await enqueueJob(store, { type: "index", payload: { repositoryRoot: repository.root } }); }
				finally { await store.close(); }
			}
			await saveState(config.stateRoot, state);
			success(command, result);
			return;
		}
		if (subcommand === "export") {
			const ref = option(args, "--ref");
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "export_brain", { ...(ref ? { ref } : {}), includeDeleted: args.includes("--include-deleted") }));
			return;
		}
		if (subcommand === "import") {
			const file = option(args, "--file");
			const format = option(args, "--format");
			if (!file || !format || !["eml", "mbox", "ics", "meeting"].includes(format)) throw new Error("usage: brain import --file <path> --format eml|mbox|ics|meeting --repo <path>");
			const text = await Bun.file(file).text();
			const imported = format === "eml" ? [genericImportModule.importEml(text)]
				: format === "mbox" ? genericImportModule.importMbox(text)
				: format === "ics" ? genericImportModule.importIcs(text)
				: [genericImportModule.importMeeting(text)];
			const sourceId = option(args, "--source-id") ?? `local-import:${format}`;
			const result = await syncSource({
				id: sourceId,
				describe: () => ({ id: sourceId, version: "1", kind: format, trusted: true }),
				list: async () => imported,
			}, repository);
			const storePath = option(args, "--store");
			if (storePath) {
				const store = await openPgliteBrainStore(storePath);
				try { await enqueueJob(store, { type: "index", payload: { repositoryRoot: repository.root } }); }
				finally { await store.close(); }
			}
			success(command, { ...result, sourceId, imported: imported.length });
			return;
		}
		if (subcommand === "list") {
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "list_pages", { includeDeleted: args.includes("--include-deleted") }));
			return;
		}
		const path = option(args, "--path");
		if (subcommand === "get") {
			if (!path) throw new Error("usage: brain get --path <path>");
			const ref = option(args, "--ref");
			try { success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, ref ? "get_page_at" : "get_page", ref ? { path, ref } : { path, includeDeleted: args.includes("--include-deleted") })); }
			catch (error) { if (error instanceof Error && error.message === "invalid params") throw new Error("brain page not found"); throw error; }
			return;
		}
		if (subcommand === "put") {
			const content = option(args, "--content");
			if (!path || content === undefined) throw new Error("usage: brain put --path <path> --content <markdown>");
			const expectedRevision = option(args, "--expected-revision");
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "put_page", { path, content, ...(expectedRevision ? { expectedRevision } : {}), expectedHead: option(args, "--expected-head") ?? null }));
			return;
		}
		if (subcommand === "move") {
			const from = option(args, "--from");
			const to = option(args, "--to");
			const expected = option(args, "--expected-revision");
			if (!from || !to || !expected) throw new Error("usage: brain move --from <path> --to <path> --expected-revision <revision>");
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "move_page", { from, to, expectedRevision: expected, expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "delete") {
			const expected = option(args, "--expected-revision");
			if (!path || !expected) throw new Error("usage: brain delete --path <path> --expected-revision <revision>");
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "delete_page", { path, expectedRevision: expected, expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "restore") {
			const id = option(args, "--id");
			const expected = option(args, "--expected-revision");
			if (!id || !path || !expected) throw new Error("usage: brain restore --id <id> --path <path> --expected-revision <revision>");
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "restore_page", { id, path, expectedRevision: expected, expectedHead: option(args, "--expected-head") }));
			return;
		}
		if (subcommand === "purge") {
			const id = option(args, "--id");
			if (!args.includes("--confirm-purge") || !id) throw new Error("usage: brain purge --id <deleted-page-id> --confirm-purge --expected-head <git-commit>");
			const retentionDays = option(args, "--retention-days");
			success(command, await brainOperationModule.executeBrainRepositoryOperation(repository, "purge_deleted_page", { id, expectedHead: option(args, "--expected-head"), ...(retentionDays ? { retentionDays: Number(retentionDays) } : {}) }));
			return;
		}
		throw new Error("usage: brain init|migrate|verify|doctor|repair|history|revert|status|schema|access|index|embed|search|related|sources-list|sources-sync|import|extract|export|list|get|put|move|delete|restore|purge");
	}
	if (command === "sync") {
		rejectUnknownFlags(args.slice(1), ["--provider", "--dry-run", "--config", "--scheduled"]);
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
		rejectUnknownFlags(args.slice(1), ["--config"]);
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
		rejectUnknownFlags(args.slice(1), ["--config"]);
		if (!isCompiledExecutable(Bun.main))
			throw new Error("scheduling requires an installed release binary; source execution supports --no-schedule only");
		if (!configPath) throw new Error("install-launch-agent requires --config <path>");
		const path = await installLaunchAgent(config, { installedBinary: process.execPath, configPath });
		success(command, { installed: true, path });
		return;
	}
	if (command === "migrate-chat-history-sync") {
		rejectUnknownFlags(args.slice(1), ["--config"]);
		if (!configPath) throw new Error("migrate-chat-history-sync requires --config <path>");
		const migration = { preflightChatHistorySyncMigration };
		success(command, await migration.preflightChatHistorySyncMigration(configPath));
		return;
	}
	if (command === "status" || command === "sync-status") {
		rejectUnknownFlags(args.slice(1), ["--config"]);
		success(command, await statusService(config));
		return;
	}
	if (command === "index") {
		rejectUnknownFlags(args.slice(1), ["--rebuild", "--repair"]);
		if (args.includes("--rebuild") && args.includes("--repair"))
			throw new Error("choose either --rebuild or --repair");
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
		const nessieId = args[1];
		if (!nessieId) throw new Error("usage: get <nessie-id>");
		if (args.length !== 2) throw new Error("usage: get <nessie-id>");
		success(command, await getService(config, nessieId));
		return;
	}
	if (command === "related") {
		const nessieId = args[1];
		if (!nessieId) throw new Error("usage: related <nessie-id>");
		if (args.length !== 2) throw new Error("usage: related <nessie-id>");
		success(command, await relatedService(config, nessieId));
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
		const storePath = option(args, "--store");
		if (!storePath) throw new Error("jobs commands require --store <pglite-directory>");
		const tenantId = option(args, "--tenant") ?? "local";
		const store = await openPgliteBrainStore(storePath);
		try {
			if (subcommand === "list") { success(command, { jobs: await listJobs(store, Number(option(args, "--limit") ?? "100"), tenantId) }); return; }
			if (subcommand === "schedules") { success(command, { schedules: await listJobSchedules(store, tenantId) }); return; }
			if (subcommand === "cancel") {
				const id = option(args, "--id");
				if (!id) throw new Error("jobs cancel requires --id <job-id>");
				await cancelJob(store, id, tenantId);
				success(command, { cancelled: id });
				return;
			}
			const root = option(args, "--repo") ?? process.env.MANAS_BRAIN_REPOSITORY;
			if (!root) throw new Error("jobs index commands require --repo <brain-repository>");
			if (subcommand === "enqueue-index") { success(command, { job: await enqueueJob(store, { type: "index", payload: { repositoryRoot: root }, tenantId, availableAt: scheduledAt(args) }) }); return; }
			if (subcommand === "schedule-index") {
				const intervalSeconds = Number(option(args, "--every-seconds"));
				if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) throw new Error("jobs schedule-index requires --every-seconds <positive-integer>");
				success(command, { schedule: await createJobSchedule(store, { type: "index", payload: { repositoryRoot: root }, tenantId, intervalSeconds, nextRunAt: scheduledAt(args) }) });
				return;
			}
			if (subcommand === "run-one") {
				const workerId = `cli-${process.pid}`;
				const runtimeConfig = await loadConfig();
				const configured = runtimeConfig.providers ?? {};
				if (configured.embedding && configured.embedding.dimensions === undefined) throw new Error("configured embedding provider dimensions are required");
					const embeddingDimensions = configured.embedding?.dimensions;
				const parityHandlers = createParityJobHandlers({
					store,
					workerId,
					tenantId,
					...(configured.embedding && embeddingDimensions !== undefined ? { embeddingProvider: new OpenAiCompatibleEmbeddingProvider({ id: configured.embedding.model, dimensions: embeddingDimensions }, configured.embedding.endpoint, configured.embedding.apiKey, configured.embedding.privacy) } : {}),
					...(configured.transcription ? { transcriptionProvider: new OpenAiCompatibleTranscriptionProvider(configured.transcription.model, configured.transcription.endpoint, configured.transcription.apiKey, configured.transcription.privacy) } : {}),
					...(configured.extraction ? { structuredExtractionProvider: new OpenAiCompatibleStructuredExtractionProvider(configured.extraction.model, configured.extraction.endpoint, configured.extraction.apiKey, configured.extraction.privacy) } : {}),
				});
				const handlers = { ...parityHandlers, index: parityHandlers.indexing, projection: parityHandlers["projection-repair"] };
				const job = await runOneJob(store, workerId, handlers, { tenantId });
				success(command, { job });
				return;
			}
			throw new Error("usage: jobs list|enqueue-index|schedule-index|schedules|run-one|cancel --store <pglite-directory> [--repo <brain-repository>]");
		}
		finally { await store.close(); }
		return;
	}
	if (command === "auth") {
		const subcommand = args[1];
		rejectUnknownFlags(args.slice(2), ["--store", "--name", "--scopes", "--id", "--user-id", "--expires-at", "--tenant", "--limit"]);
		const storePath = option(args, "--store");
		if (!storePath) throw new Error("auth commands require --store <pglite-directory>");
		const tenantId = option(args, "--tenant") ?? "local";
		const store = await openPgliteBrainStore(storePath);
		try {
			if (subcommand === "list") { success(command, { tokens: await listPersonalAccessTokens(store, tenantId) }); return; }
			if (subcommand === "events") { success(command, { events: (await listAuditEvents(store, tenantId, Number(option(args, "--limit") ?? "100"))).map(redactAdminEvent) }); return; }
			if (subcommand === "revoke") {
				const id = option(args, "--id");
				if (!id) throw new Error("auth revoke requires --id <token-id>");
				await revokePersonalAccessToken(store, id, tenantId);
				success(command, { revoked: id });
				return;
			}
			if (subcommand === "create") {
				const name = option(args, "--name");
				const scopeText = option(args, "--scopes");
				const userId = option(args, "--user-id");
				const expiryText = option(args, "--expires-at");
				if (!name || !scopeText) throw new Error("auth create requires --name <name> --scopes <read,write,admin>");
				const expiresAt = expiryText ? new Date(expiryText) : undefined;
				if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("--expires-at must be an ISO timestamp");
				success(command, await createPersonalAccessToken(store, { name, scopes: scopeText.split(",") as Array<"read" | "write" | "admin">, tenantId, ...(userId ? { userId } : {}), expiresAt }));
				return;
			}
			throw new Error("usage: auth create|list|events|revoke --store <pglite-directory>");
		} finally { await store.close(); }
		return;
	}
	if (command === "serve") {
		rejectUnknownFlags(args.slice(1), ["--http-port", "--store"]);
		const rawPort = option(args, "--http-port");
		if (rawPort) {
			const port = Number(rawPort);
			const token = process.env.MANAS_MCP_TOKEN;
			if (!token) throw new Error("MANAS_MCP_TOKEN is required for HTTP MCP");
			const storePath = option(args, "--store");
			const store = storePath ? await openPgliteBrainStore(storePath) : undefined;
			const remoteRoot = process.env.MANAS_BRAIN_REPOSITORY;
			const operationRegistry = remoteRoot ? operationCatalogModule.createFullOperationRegistry({ repository: new BrainRepository(remoteRoot), ...(store ? { store, controlPlane: new controlPlaneModule.DurableControlPlane(store) } : {}) }) : undefined;
		serveMcpHttp(config, { port, token, scopes: mcpScopes(), authorizeToken: store ? (candidate: string, scope: "read" | "write" | "admin", tenantId?: string) => authorizePersonalAccessToken(store, candidate, scope, tenantId ?? "local") : undefined, principalForToken: store ? (candidate: string) => identifyPersonalAccessToken(store, candidate) : undefined, authorizeOperation: store ? hostedOperationAuthorizer(store) : undefined, operationRegistry });
			await new Promise<void>(() => undefined);
		}
		const storePath = option(args, "--store");
		const store = storePath ? await openPgliteBrainStore(storePath) : undefined;
		const localRoot = process.env.MANAS_BRAIN_REPOSITORY;
		const operationRegistry = localRoot ? operationCatalogModule.createFullOperationRegistry({ repository: new BrainRepository(localRoot), ...(store ? { store, controlPlane: new controlPlaneModule.DurableControlPlane(store) } : {}) }) : undefined;
		try { await serveMcp(config, { operationRegistry }); }
		finally { await store?.close(); }
		return;
	}
	throw new Error(`unknown command: ${command}`);
}

try {
	await main();
} catch (error) {
	if (process.argv[2] !== "serve") failure(process.argv[2], error);
	if (process.argv[2] !== "setup") process.exitCode = 1;
}
