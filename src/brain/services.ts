import { readFile } from "node:fs/promises";
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

export async function getService(config: Config, nessieId: string) {
	if (!nessieId) throw new Error("document not found");
	const database = await openBrainDatabase(config.brain!.databasePath);
	try {
		const row = database
			.prepare("SELECT relative_path FROM documents WHERE nessie_id = ?")
			.get(nessieId) as { relative_path?: string } | null;
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

export async function relatedService(config: Config, nessieId: string) {
	if (!nessieId) throw new Error("document not found");
	const database = await openBrainDatabase(config.brain!.databasePath);
	try {
		return relatedDocuments(database, nessieId);
	} finally {
		database.close();
	}
}

/** Status deliberately performs no network dependency checks. */
export async function statusService(config: Config) {
	const folders = new Map<string, number>();
	let documents = 0;
	let truncated = false;
	const maximumDocuments = 10_000;
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
	const state = await loadState(config.stateRoot);
	return {
		archive: config.archiveRoot,
		documents,
		folders: Object.fromEntries(folders),
		stateFingerprints: Object.keys(state.fingerprints).length,
		zeroEntropy: config.brain
			? { collection: config.brain.zeroEntropyCollection, configured: true }
			: undefined,
		warnings: truncated ? ["archive metadata count reached its limit"] : [],
	};
}

export async function healthService(config: Config) {
	return brainHealth(config);
}
