import { canonicalRead, canonicalSearchOutcome } from "../canonical-services";
import { assertLocalInferenceConfig } from "./local-inference";
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
	const canonical = await canonicalRead(config, "retrieval.search", { query, options });
	if (canonical !== undefined) return canonicalSearchOutcome(canonical as Parameters<typeof canonicalSearchOutcome>[0], options);
	return searchArchiveOutcome(config, query, options);
}

export async function thinkService(config: Config, question: string) {
	assertLocalInferenceConfig(config);
	const canonical = await canonicalRead(config, "reasoning.answer", { question });
	if (canonical !== undefined) {
		const result = canonical as import("./reasoning").ReasonedAnswer & { outcome: "answered" | "insufficient_evidence" | "synthesis_failed"; code?: string };
		const shared = { evidence: [] as import("../model").SearchResult[], citations: result.citations.map((citation) => ({ ...citation, manasId: citation.documentId })), knowledgeGaps: result.knowledgeGaps };
		if (result.outcome === "answered" && result.answer) return { ...shared, outcome: "answered" as const, answer: result.answer };
		if (result.outcome === "insufficient_evidence") return { ...shared, outcome: "insufficient_evidence" as const, code: "insufficient_evidence" as const };
		return { ...shared, outcome: "synthesis_failed" as const, code: result.code === "local_model_not_configured" ? "local_model_not_configured" as const : "grounding_failed" as const };
	}
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
	const canonical = await canonicalRead(config, "retrieval.get", { id: manasId });
	if (canonical !== undefined) return (canonical as { content: string }).content;
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
	const canonical = await canonicalRead(config, "retrieval.related", { id: manasId });
	if (canonical !== undefined) return canonical as Awaited<ReturnType<typeof relatedDocuments>>;
	const database = await openBrainDatabase(config.brain!.databasePath);
	try {
		return relatedDocuments(database, manasId);
	} finally {
		database.close();
	}
}

/** Status deliberately performs no network dependency checks. */
export async function statusService(config: Config) {
	const canonical = await canonicalRead(config, "brain_status", {});
	if (canonical !== undefined) {
		const status = canonical as { head: string; settings: unknown; pages: { active: number; deleted: number } };
		return { ...status, documents: status.pages.active, mode: "canonical", warnings: [] as string[] };
	}
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
		if (process.platform !== "darwin") return false;
		const scope = ["gui", String(process.getuid?.() ?? 0), label].join(String.fromCharCode(47));
		try {
			const run = Bun.spawn(["launchctl", "print", scope], { stdout: "ignore", stderr: "ignore" });
			return await run.exited === 0;
		} catch {
			return false;
		}
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
			? { collection: config.brain.zeroEntropyCollection, configured: false, enabled: false, status: "disabled" as const }
			: undefined,
		warnings: [...warnings, ...(truncated ? ["archive metadata count reached its limit"] : [])],
	};
}

export async function healthService(config: Config) {
	const canonical = await canonicalRead(config, "integrity.check", {});
	if (canonical !== undefined) { const result = canonical as { repository: { valid: boolean } }; return { ok: result.repository.valid, mode: "canonical", ...result }; }
	return brainHealth(config);
}
