import { chmod, writeFile } from "node:fs/promises";
import type {
	AdapterResult,
	AdapterWarning,
	Conversation,
	Provider,
	SyncReport,
	SyncTotals,
} from "./model";
import {
	applyArchiveChanges,
	ensureArchiveRoot,
	planArchiveChanges,
	scanArchive,
} from "./archive";
import { defaultConfig, type Config } from "./config";
import { regenerateIndexes } from "./indexes";
import { renderSyncReport, verifyArchive } from "./report";
import { indexArchive } from "./brain/indexer";
import { loadState, saveState, withStateLock } from "./state";
import { discoverClaudeCode } from "./adapters/claude-code";
import { discoverCodex } from "./adapters/codex";
import { discoverPi } from "./adapters/pi";
import { discoverCursor } from "./adapters/cursor";
import { discoverGrok } from "./adapters/grok";

export interface SyncOptions {
	provider?: Provider;
	dryRun?: boolean;
	conversations?: Conversation[];
	scanned?: number;
	extraWarnings?: AdapterWarning[];
}

export interface SyncResult {
	report: SyncReport;
	changes: ReturnType<typeof planArchiveChanges>;
	dryRun: boolean;
}

const adapters: Record<Provider, (() => Promise<AdapterResult>) | undefined> = {
	claude_code: discoverClaudeCode,
	codex: discoverCodex,
	pi: discoverPi,
	cursor: discoverCursor,
	grok: discoverGrok,
	chatgpt: undefined,
	claude: undefined,
};

function zeroTotals(): SyncTotals {
	return {
		scanned: 0,
		created: 0,
		updated: 0,
		skipped: 0,
		redacted: 0,
		warnings: 0,
		failures: 0,
	};
}

function addTotals(target: SyncTotals, source: Partial<SyncTotals>): void {
	target.scanned += source.scanned ?? 0;
	target.created += source.created ?? 0;
	target.updated += source.updated ?? 0;
	target.skipped += source.skipped ?? 0;
	target.redacted += source.redacted ?? 0;
	target.warnings += source.warnings ?? 0;
	target.failures += source.failures ?? 0;
}

function deduplicateConversations(
	conversations: Conversation[],
	warnings: AdapterWarning[],
): Conversation[] {
	const selected = new Map<string, Conversation>();
	for (const conversation of conversations) {
		const key = `${conversation.provider}\0${conversation.sourceId}`;
		const existing = selected.get(key);
		if (!existing) selected.set(key, conversation);
		else {
			const replacement =
				(conversation.updatedAt ?? "") > (existing.updatedAt ?? "") ||
				conversation.messages.length > existing.messages.length;
			if (replacement) selected.set(key, conversation);
			warnings.push({
				provider: conversation.provider,
				sourcePath: conversation.sourcePath,
				message: `duplicate source ID ${conversation.sourceId}; selected the most complete/latest record`,
			});
		}
	}
	return [...selected.values()];
}

export async function discoverLocalSources(
	provider?: Provider,
): Promise<{
	conversations: Conversation[];
	results: AdapterResult[];
	warnings: AdapterWarning[];
	failures: AdapterWarning[];
}> {
	return discover({ provider });
}

async function discover(
	options: SyncOptions,
): Promise<{
	conversations: Conversation[];
	results: AdapterResult[];
	warnings: AdapterWarning[];
	failures: AdapterWarning[];
}> {
	if (options.conversations)
		return {
			conversations: options.conversations,
			results: [],
			warnings: options.extraWarnings ?? [],
			failures: [],
		};
	const results: AdapterResult[] = [];
	const warnings: AdapterWarning[] = [...(options.extraWarnings ?? [])];
	const failures: AdapterWarning[] = [];
	const providers = options.provider
		? [options.provider]
		: (["claude_code", "codex", "pi", "cursor", "grok"] as Provider[]);
	for (const provider of providers) {
		const adapter = adapters[provider];
		if (!adapter) continue;
		try {
			const result = await adapter();
			results.push(result);
			warnings.push(...result.warnings);
			failures.push(...result.failures);
		} catch (error) {
			failures.push({ provider, message: (error as Error).message });
		}
	}
	return {
		conversations: results.flatMap((result) => result.conversations),
		results,
		warnings,
		failures,
	};
}

export async function runSync(
	config: Config = defaultConfig(),
	options: SyncOptions = {},
): Promise<SyncResult> {
	return withStateLock(config.stateRoot, async () => {
		await ensureArchiveRoot(config.archiveRoot);
		const state = await loadState(config.stateRoot);
		const before = await scanArchive(config.archiveRoot);
		const discovered = await discover(options);
		const adapterConversations = discovered.results.flatMap(
			(result) => result.conversations,
		);
		const warnings: AdapterWarning[] = [
			...before.warnings.map((message) => ({ provider: "archive", message })),
			...discovered.warnings,
		];
		const failures = [...discovered.failures];
		const conversations = deduplicateConversations(
			options.conversations ?? adapterConversations,
			warnings,
		);
		const changes = planArchiveChanges(
			before,
			conversations,
			config.archiveRoot,
		);
		const providers = new Map<string, SyncTotals>();
		for (const result of discovered.results) {
			const totals = providers.get(result.provider) ?? zeroTotals();
			totals.scanned += result.scanned;
			totals.warnings += result.warnings.length;
			totals.failures += result.failures.length;
			totals.redacted += result.conversations.reduce(
				(sum, conversation) => sum + conversation.redactions,
				0,
			);
			providers.set(result.provider, totals);
		}
		if (options.conversations) {
			const provider = options.conversations[0]?.provider;
			if (provider) {
				const totals = providers.get(provider) ?? zeroTotals();
				totals.scanned += options.scanned ?? options.conversations.length;
				totals.redacted += options.conversations.reduce(
					(sum, conversation) => sum + conversation.redactions,
					0,
				);
				providers.set(provider, totals);
			}
		}
		for (const change of changes) {
			const totals = providers.get(change.provider) ?? zeroTotals();
			totals[
				change.kind === "create"
					? "created"
					: change.kind === "update"
						? "updated"
						: "skipped"
			] += 1;
			providers.set(change.provider, totals);
		}
		const reportTotals = zeroTotals();
		for (const totals of providers.values()) addTotals(reportTotals, totals);
		reportTotals.warnings = warnings.length;
		reportTotals.failures = failures.length;
		const report: SyncReport = {
			totals: reportTotals,
			providers: Object.fromEntries(
				[...providers.entries()].sort(([left], [right]) =>
					left.localeCompare(right),
				),
			),
			warnings,
			failures,
		};
		if (!options.dryRun) {
			await applyArchiveChanges(config.archiveRoot, changes, false);
			const after = await scanArchive(config.archiveRoot);
			await regenerateIndexes(config.archiveRoot, after);
			const verification = await verifyArchive(config.archiveRoot);
			if (!verification.ok) {
				failures.push({
					provider: "index",
					message: `archive verification failed: ${verification.errors.join("; ")}`,
				});
				report.totals.failures = failures.length;
			} else if (config.brain) {
				try {
					const indexed = await indexArchive(config);
					for (const message of indexed.deferred)
						warnings.push({ provider: "index", message });
					report.totals.warnings = warnings.length;
				} catch (error) {
					failures.push({
						provider: "index",
						message: error instanceof Error ? error.message : "indexing failed",
					});
					report.totals.failures = failures.length;
				}
			}
			await writeFile(
				`${config.archiveRoot}/SYNC_REPORT.md`,
				renderSyncReport(report),
				{ mode: 0o600 },
			);
			await chmod(`${config.archiveRoot}/SYNC_REPORT.md`, 0o600);
			const fingerprints = { ...state.fingerprints };
			for (const conversation of conversations)
				fingerprints[`${conversation.provider}\0${conversation.sourceId}`] =
					conversation.fingerprint;
			await saveState(config.stateRoot, {
				version: 1,
				fingerprints,
				lastReport: report,
			});
		}
		return { report, changes, dryRun: Boolean(options.dryRun) };
	});
}
