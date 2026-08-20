import * as sourceModule from "../sync";
import { access, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { scanArchive } from "../archive";
import type { Config } from "../config";
import type { SearchOptions } from "../model";
import { loadState } from "../state";
import { safeRelativePath } from "../utils";
import { openBrainDatabase } from "./database";
import { relatedDocuments } from "./graph";
import { brainHealth } from "./health";
import { searchArchiveOutcome, validateSearchOptions } from "./search";
import { think, thinkWithGenerationProvider } from "./synthesis";
import { OpenAiCompatibleGenerationProvider } from "./providers";

/** Shared read-only application operations used by both transports. */
export function validateServiceSearch(options: SearchOptions): void {
	validateSearchOptions(options);
}

export async function searchService(
	config: Config,
	query: string,
	options: SearchOptions = {},
) {
	if (!query.trim())
		throw new Error("search query must contain letters or numbers");
	validateServiceSearch(options);
	return searchArchiveOutcome(config, query, options);
}

export async function thinkService(config: Config, question: string) {
	const configured = config.providers?.generation ?? (config.brain?.generationEndpoint && config.brain.generationModel ? {
		endpoint: config.brain.generationEndpoint,
		model: config.brain.generationModel,
		privacy: "local" as const,
	} : undefined);
	if (configured) {
		const provider = new OpenAiCompatibleGenerationProvider(configured.model, configured.endpoint, configured.apiKey, configured.privacy, { provider: configured.provider, revision: configured.revision }, { timeoutMs: config.brain?.requestTimeoutMs });
		return thinkWithGenerationProvider(config, question, provider);
	}
	return think(config, question);
}

export async function getService(config: Config, manasId: string) {
	if (!manasId) throw new Error("document not found");
	const database = await openBrainDatabase(config.brain!.databasePath);
	try {
		const row = database
			.prepare("SELECT relative_path FROM documents WHERE manas_id = ?")
			.get(manasId) as { relative_path?: string } | null;
		if (!row?.relative_path) throw new Error("document not found");
		return readFile(
			join(
				config.archiveRoot,
				safeRelativePath(config.archiveRoot, row.relative_path),
			),
			"utf8",
		);
	} finally {
		database.close();
	}
}

export async function relatedService(config: Config, manasId: string) {
	if (!manasId) throw new Error("document not found");
	const database = await openBrainDatabase(config.brain!.databasePath);
	try {
		return relatedDocuments(database, manasId);
	} finally {
		database.close();
	}
}

/** Status deliberately performs no network dependency checks. */
export async function statusService(config: Config) {
	const folders = new Map<string, number>();
	let documents = 0;
	let truncated = false;
	let archiveAvailable = false;
	const warnings: string[] = [];
	const maximumDocuments = 10_000;
	try {
		await access(config.archiveRoot);
		archiveAvailable = true;
		for await (const path of new Bun.Glob("**").scan({
			cwd: config.archiveRoot,
			onlyFiles: true,
		})) {
			const parts = path.split(String.fromCharCode(47));
			if (!path.endsWith(".md") || parts.some((part) => part.startsWith(".")))
				continue;
			const folder = parts.at(0) ?? ".";
			folders.set(folder, (folders.get(folder) ?? 0) + 1);
			documents++;
			if (documents >= maximumDocuments) {
				truncated = true;
				break;
			}
		}
	} catch {
		warnings.push(`archive directory is unavailable: ${config.archiveRoot}`);
	}
	const state = await loadState(config.stateRoot);
	const localSources = archiveAvailable ? await (sourceModule.discoverLocalSources as () => Promise<{ conversations: Array<{ updatedAt?: string }> }>)() : { conversations: [] };
	let newestSourceTimestamp: string | undefined;
	for (const conversation of localSources.conversations) if (conversation.updatedAt && (!newestSourceTimestamp || newestSourceTimestamp < conversation.updatedAt)) newestSourceTimestamp = conversation.updatedAt;
	const newestArchive = async (): Promise<string | undefined> => {
		let newest = 0;
		for await (const path of new Bun.Glob("**").scan({ cwd: config.archiveRoot, onlyFiles: true })) if (path.endsWith(".md")) newest = Math.max(newest, (await stat(join(config.archiveRoot, path))).mtimeMs);
		return newest ? new Date(newest).toISOString() : undefined;
	};
	const loaded = async (label: string): Promise<boolean> => {
		const scope = ["gui", String(process.getuid?.() ?? 0), label].join(String.fromCharCode(47));
		const run = Bun.spawn(["launchctl", "print", scope], { stdout: "ignore", stderr: "ignore" });
		return await run.exited === 0;
	};
	return {
		archive: config.archiveRoot,
		configuredArchivePath: config.archiveRoot,
		documents,
		folders: Object.fromEntries(folders),
		stateFingerprints: Object.keys(state.fingerprints).length,
		lastSuccessfulSync: state.lastReport ? (await stat(join(config.stateRoot, "state.json")).then((value) => value.mtime.toISOString()).catch(() => undefined)) : undefined,
		lastResult: state.lastReport ? { totals: state.lastReport.totals, failures: state.lastReport.failures } : undefined,
		launchAgents: { manasLoaded: await loaded("com.collindjohnson.manas"), legacyLoaded: await loaded("com.virdis.chat-history-sync") },
		newestArchivedChatTimestamp: archiveAvailable ? await newestArchive() : undefined,
		newestSourceChatTimestamp: newestSourceTimestamp,
		zeroEntropy: config.brain
			? { collection: config.brain.zeroEntropyCollection, configured: true }
			: undefined,
		warnings: [...warnings, ...(truncated ? ["archive metadata count reached its limit"] : [])],
	};
}

export async function healthService(config: Config) {
	return brainHealth(config);
}
