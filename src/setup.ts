import * as syncModule from "./sync";
import * as agentModule from "./launch-agent";
import * as configModule from "./config";
import * as reportModule from "./report";
import * as fileSystem from "node:fs";
import { homedir } from "node:os";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeSetupConfiguration } from "@manas/setup-config";
import { isCompiledExecutable } from "@manas/executable";
import { defaultLegacyDependencies, detectLegacyInstallation, retireLegacyInstallation } from "@manas/legacy";
import { writeSetupConfiguration } from "@manas/setup-persistence";
import { MANAS_VERSION } from "@manas-version";
import { activateAndVerifyMacScheduler } from "@manas/scheduler-activation";
import { waitForScheduledSyncReceipt } from "@manas/scheduler-receipt";
import { setupSourceRegistry } from "@manas/setup-sources";
import { selectArchiveCandidate } from "@manas/setup-archive";

type Provider = "claude_code" | "codex" | "pi" | "cursor" | "grok" | "chatgpt" | "claude";
type Totals = {
	scanned: number;
	created: number;
	updated: number;
	skipped: number;
	redacted: number;
	warnings: number;
	failures: number;
};
type Report = { totals: Totals; failures: unknown[] };
type SetupConfig = {
	configVersion: 1;
	archiveRoot: string;
	stateRoot: string;
	launchAgentPath: string;
};

export const DEFAULT_SETUP_CONFIG = resolve(
	homedir(),
	".config",
	"manas",
	"config.json",
);

export interface SetupOptions {
	archiveRoot?: string;
	stateRoot?: string;
	configPath?: string;
	detectOnly?: boolean;
	previewOnly?: boolean;
	noSchedule?: boolean;
	yes?: boolean;
	allowEmpty?: boolean;
	retireLegacy?: boolean;
	repair?: boolean;
}

export interface DetectedSetupSource {
	provider: Provider;
	detected: boolean;
	scanned: number;
	eligible: number;
	warnings: number;
	failures: number;
}

export interface SetupResult {
	mode: "detect-only" | "preview" | "configured" | "activated";
	configPath: string;
	archiveRoot: string;
	stateRoot: string;
	sources: DetectedSetupSource[];
	preview?: { totals: Totals; changes: number };
	sync?: { totals: Totals; changes: number };
	scheduler: { requested: boolean; installed: boolean; path?: string; status?: "active" | "unsupported"; warning?: string };
	legacy?: { retired: boolean; backupPath?: string };
}

export function setupJsonDocument(result: SetupResult): Record<string, unknown> {
	return {
		schema: "manas.setup.v1",
		version: MANAS_VERSION,
		exitCode: 0,
		mode: result.mode,
		config: { path: result.configPath, archiveRoot: result.archiveRoot, stateRoot: result.stateRoot },
		sources: result.sources,
		sourceRegistry: setupSourceRegistry(),
		preview: result.preview ?? null,
		sync: result.sync ?? null,
		scheduler: result.scheduler,
		legacy: result.legacy ?? null,
		error: null,
	};
}

export interface SetupDependencies {
	discover(): Promise<{
		conversations: Array<{ provider: Provider; sourceId?: string; updatedAt?: string }>;
		results: Array<{
			provider: Provider;
			scanned: number;
			warnings: unknown[];
			failures: unknown[];
		}>;
	}>;
	runSync(
		config: SetupConfig,
		options?: { dryRun?: boolean; conversations?: Array<{ provider: Provider; sourceId?: string; updatedAt?: string }> },
	): Promise<{ report: Report; changes: unknown[] }>;
	installAgent(config: SetupConfig, configPath: string): Promise<string>;
	activateAgent(path: string, config: SetupConfig, configPath: string): Promise<void>;
	snapshotAgent?(path: string): Promise<() => Promise<void>>;
	filesystem?: {
		exists(path: string): Promise<boolean>;
		readText(path: string): Promise<string>;
		remove(path: string): Promise<void>;
	};
	configuration?: {
		load(path: string): Promise<Awaited<ReturnType<typeof configModule.loadConfig>>>;
		write(path: string, value: SetupConfig): Promise<void>;
	};
	archive?: {
		exists(path: string): Promise<boolean>;
		verify(path: string): Promise<{ ok: boolean; errors: string[] }>;
	};
	clock?: { now(): Date };
	terminal?: { confirm(message: string): Promise<boolean> };
	runtime?: { entrypoint: string; platform: string };
	confirm(message: string): Promise<boolean>;
}

export function assertSchedulingRuntime(requested: boolean, entrypoint = Bun.main): void {
	if (requested && !isCompiledExecutable(entrypoint))
		throw new Error("scheduling requires an installed release binary; source execution supports --no-schedule only");
}

export function schedulerAvailability(
	requested: boolean,
	platform: string = process.platform,
): { requested: boolean; supported: boolean; warning?: string } {
	const supported = platform === "darwin";
	return {
		requested,
		supported,
		...(!supported && requested
			? { warning: "automatic scheduling is supported only on macOS" }
			: {}),
	};
}

function terminalConfirm(message: string): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error(
			"setup requires --yes when no interactive terminal is available",
		);
	const answer = globalThis.prompt(`${message} [y/N]`)?.trim().toLowerCase();
	return Promise.resolve(answer === "y" || answer === "yes");
}

async function defaultDependencies(): Promise<SetupDependencies> {
	return {
		discover: syncModule.discoverLocalSources,
		runSync: syncModule.runSync,
		installAgent: (config: SetupConfig, configPath: string) =>
			agentModule.installLaunchAgent(config, {
				installedBinary: process.execPath,
				configPath,
			}),
		activateAgent: async (path: string, config: SetupConfig, configPath: string) => {
			const startedAt = new Date().toISOString();
			await activateAndVerifyMacScheduler({
				plistPath: path,
				uid: process.getuid?.() ?? 0,
				label: "com.collindjohnson.manas",
				executable: process.execPath,
				configPath,
				startedAt,
			}, {
				run: async (command) => Bun.spawn(command).exited,
				waitForReceipt: (after, timeoutMs) => waitForScheduledSyncReceipt(config.stateRoot, after, timeoutMs),
				verifyArchive: () => reportModule.verifyArchive(config.archiveRoot),
				verifyLog: () => Bun.file(resolve(config.stateRoot, "launch-agent.log")).exists(),
			});
		},
		snapshotAgent: async (path: string) => {
			const existed = await Bun.file(path).exists();
			const prior = existed ? await readFile(path, "utf8") : undefined;
			return async () => {
				const uid = process.getuid?.() ?? 0;
				const label = `gui${String.fromCharCode(47)}${uid}${String.fromCharCode(47)}com.collindjohnson.manas`;
				await Bun.spawn(["launchctl", "bootout", label]).exited;
				if (prior !== undefined) {
					await writeFile(path, prior, { mode: 0o644 });
					const domain = `gui${String.fromCharCode(47)}${uid}`;
					if (await Bun.spawn(["launchctl", "bootstrap", domain, path]).exited !== 0)
						throw new Error("could not restore the prior Manas LaunchAgent");
				} else await rm(path, { force: true });
			};
		},
		filesystem: {
			exists: async (path) => Bun.file(path).exists(),
			readText: async (path) => Bun.file(path).text(),
			remove: async (path) => { await rm(path, { force: true }); },
		},
		configuration: {
			load: async (path) => configModule.loadConfig({ filePath: path, environment: {} }),
			write: writeSetupConfiguration,
		},
		archive: {
			exists: async (path) => fileSystem.existsSync(path),
			verify: reportModule.verifyArchive,
		},
		clock: { now: () => new Date() },
		terminal: { confirm: terminalConfirm },
		confirm: terminalConfirm,
	};
}

function summarizeSources(
	discovery: Awaited<ReturnType<SetupDependencies["discover"]>>,
): DetectedSetupSource[] {
	const eligible = new Map<Provider, number>();
	for (const conversation of discovery.conversations)
		eligible.set(
			conversation.provider,
			(eligible.get(conversation.provider) ?? 0) + 1,
		);
	return discovery.results.map((result) => ({
		provider: result.provider,
		detected: result.scanned > 0,
		scanned: result.scanned,
		eligible: eligible.get(result.provider) ?? 0,
		warnings: result.warnings.length,
		failures: result.failures.length,
	}));
}

function discoveryFingerprint(
	discovery: Awaited<ReturnType<SetupDependencies["discover"]>>,
): string {
	return JSON.stringify({
		conversations: discovery.conversations.map((conversation) => ({ provider: conversation.provider, sourceId: conversation.sourceId ?? "", updatedAt: conversation.updatedAt ?? "" })).sort((left, right) => `${left.provider}:${left.sourceId}`.localeCompare(`${right.provider}:${right.sourceId}`)),
		results: discovery.results.map((result) => ({
			provider: result.provider,
			scanned: result.scanned,
			warnings: result.warnings.length,
			failures: result.failures.length,
		})).sort((left, right) => left.provider.localeCompare(right.provider)),
	});
}

export async function setupManas(
	options: SetupOptions = {},
	dependencies?: SetupDependencies,
): Promise<SetupResult> {
	if (options.detectOnly && options.previewOnly)
		throw new Error("choose either detectOnly or previewOnly");
	for (const [name, value] of [
		["archiveRoot", options.archiveRoot],
		["stateRoot", options.stateRoot],
		["configPath", options.configPath],
	] as const)
		if (value !== undefined && !value.trim())
			throw new Error(`${name} must not be empty`);
	const configPath = resolve(options.configPath ?? DEFAULT_SETUP_CONFIG);
	const base = configModule.defaultConfig({});
	const actions = dependencies ?? (await defaultDependencies());
	const files = actions.filesystem ?? {
		exists: async (path: string) => Bun.file(path).exists(),
		readText: async (path: string) => Bun.file(path).text(),
		remove: async (path: string) => { await rm(path, { force: true }); },
	};
	const configuration = actions.configuration ?? {
		load: async (path: string) => configModule.loadConfig({ filePath: path, environment: {} }),
		write: writeSetupConfiguration,
	};
	const archive = actions.archive ?? {
		exists: async (path: string) => fileSystem.existsSync(path),
		verify: reportModule.verifyArchive,
	};
	const configExists = await files.exists(configPath);
	const previousConfiguration = configExists ? await files.readText(configPath) : undefined;
	const prior = configExists
		? await configuration.load(configPath)
		: undefined;
	const archiveRoot = selectArchiveCandidate(options.archiveRoot, prior?.archiveRoot, base.archiveRoot).path;
	const stateRoot = resolve(
		options.stateRoot ?? prior?.stateRoot ?? base.stateRoot,
	);
	const config: SetupConfig = normalizeSetupConfiguration({
		archiveRoot,
		stateRoot,
		launchAgentPath: prior?.launchAgentPath ?? base.launchAgentPath,
	});
	if (options.repair) {
		if (!configExists) throw new Error("repair requires an existing Manas configuration");
		assertSchedulingRuntime(true, actions.runtime?.entrypoint ?? Bun.main);
		if ((actions.runtime?.platform ?? process.platform) !== "darwin") throw new Error("scheduler repair is supported only on macOS");
		const restoreAgent = await actions.snapshotAgent?.(config.launchAgentPath);
		let path: string;
		try {
			path = await actions.installAgent(config, configPath);
			await actions.activateAgent(path, config, configPath);
		} catch (error) {
			try { if (restoreAgent) await restoreAgent(); }
			catch (rollbackError) { throw new Error(`scheduler repair failed and LaunchAgent rollback failed: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`); }
			throw error;
		}
		return { mode: "activated", configPath, archiveRoot, stateRoot, sources: [], scheduler: { requested: true, installed: true, path } };
	}
	const discovery = await actions.discover();
	const plannedTargets = discoveryFingerprint(discovery);
	const sources = summarizeSources(discovery);
	if (options.detectOnly)
		return {
			mode: "detect-only",
			configPath,
			archiveRoot,
			stateRoot,
			sources,
			scheduler: { requested: false, installed: false },
		};
	if (!options.allowEmpty && !sources.some((source) => source.detected))
		throw new Error("no supported local AI chat sources were detected");
	if (sources.some((source) => source.failures > 0))
		throw new Error(
			"source detection reported failures; resolve them before setup",
		);
	if (await archive.exists(archiveRoot)) {
		const archiveVerification = await archive.verify(archiveRoot);
		if (!archiveVerification.ok)
			throw new Error(
				`selected archive verification failed: ${archiveVerification.errors.join("; ")}`,
			);
	}
	const preview = await actions.runSync(config, { dryRun: true, conversations: discovery.conversations });
	if (preview.report.failures.length)
		throw new Error("setup dry-run reported failures");
	const availability = schedulerAvailability(!options.noSchedule, actions.runtime?.platform ?? process.platform);
	const requested = availability.requested;
	const schedulingSupported = availability.supported;
	const scheduleRequested = requested && schedulingSupported;
	if (options.previewOnly)
		return {
			mode: "preview",
			configPath,
			archiveRoot,
			stateRoot,
			sources,
			preview: {
				totals: preview.report.totals,
				changes: preview.changes.length,
			},
			scheduler: schedulingSupported ? { requested, installed: false } : { requested, installed: false, status: "unsupported", warning: availability.warning },
		};
	if (scheduleRequested) assertSchedulingRuntime(true, actions.runtime?.entrypoint ?? Bun.main);
	const message = `Sync ${preview.report.totals.created} new and ${preview.report.totals.updated} updated chats to ${archiveRoot}${scheduleRequested ? " and enable daily sync" : ""}?`;
	if (!options.yes && !(await (actions.terminal?.confirm(message) ?? actions.confirm(message))))
		return {
			mode: "preview",
			configPath,
			archiveRoot,
			stateRoot,
			sources,
			preview: {
				totals: preview.report.totals,
				changes: preview.changes.length,
			},
			scheduler: schedulingSupported ? { requested, installed: false } : { requested, installed: false, status: "unsupported", warning: availability.warning },
		};
	const verifiedDiscovery = await actions.discover();
	if (discoveryFingerprint(verifiedDiscovery) !== plannedTargets)
		throw new Error("detected source targets changed after preview; rerun setup preview before writing");
	const synced = await actions.runSync(config, { conversations: verifiedDiscovery.conversations });
	if (synced.report.failures.length)
		throw new Error(
			"initial setup sync reported failures; scheduler was not installed",
		);
	await configuration.write(configPath, config);
	let installedPath: string | undefined;
	let restoreAgent: (() => Promise<void>) | undefined;
	try {
		if (scheduleRequested) {
			restoreAgent = await actions.snapshotAgent?.(config.launchAgentPath);
			installedPath = await actions.installAgent(config, configPath);
			await actions.activateAgent(installedPath, config, configPath);
		}
	} catch (error) {
		let restoreError: unknown;
		try { if (restoreAgent) await restoreAgent(); }
		catch (rollbackError) { restoreError = rollbackError; }
		if (previousConfiguration !== undefined) await configuration.write(configPath, JSON.parse(previousConfiguration));
		else await files.remove(configPath);
		const rollback = restoreError instanceof Error ? `; LaunchAgent rollback failed: ${restoreError.message}` : "";
		const failure = new Error(`scheduler activation failed; configuration rollback completed: ${error instanceof Error ? error.message : "unknown error"}${rollback}`);
		Object.assign(failure, {
			setupExitCode: 6,
			setupCode: "scheduler_activation_failed",
			setupPartial: {
				mode: "configured",
				configPath,
				archiveRoot,
				stateRoot,
				sources,
				preview: { totals: preview.report.totals, changes: preview.changes.length },
				sync: { totals: synced.report.totals, changes: synced.changes.length },
				scheduler: { requested, installed: false },
			} satisfies SetupResult,
		});
		throw failure;
	}
	let legacy: SetupResult["legacy"];
	if (options.retireLegacy) {
		const path = resolve(homedir(), "Library", "LaunchAgents", "com.virdis.chat-history-sync.plist");
		const retired = await retireLegacyInstallation(await detectLegacyInstallation(path), resolve(config.stateRoot, "legacy-backups"), Boolean(options.yes), (actions.clock?.now() ?? new Date()).toISOString().replaceAll(":", "-"), await defaultLegacyDependencies());
		legacy = { retired: Boolean(retired), ...(retired ? { backupPath: retired.backupPath } : {}) };
	}
	return {
		mode: scheduleRequested ? "activated" : "configured",
		configPath,
		archiveRoot,
		stateRoot,
		sources,
		preview: {
			totals: preview.report.totals,
			changes: preview.changes.length,
		},
		sync: {
			totals: synced.report.totals,
			changes: synced.changes.length,
		},
		scheduler: {
			requested,
			installed: Boolean(installedPath),
			...(installedPath ? { path: installedPath } : {}),
			...(!schedulingSupported ? { status: "unsupported" as const, warning: availability.warning } : installedPath ? { status: "active" as const } : {}),
		},
		...(legacy ? { legacy } : {}),
	};
}
