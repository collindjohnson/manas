import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type { Config } from "./config";
import { readArchiveMigration } from "./archive-migration";
import { BrainRepository } from "./brain/repository";
import { acquireStoreOwnership } from "./brain/ownership";
import { openPgliteBrainStore } from "./brain/store";
import { indexBrainRepository, searchVerifiedHybridBrainRepository } from "./brain/pglite-indexer";
import { indexArchive } from "./brain/indexer";
import { searchArchive } from "./brain/search";
import { writeSetupConfiguration } from "./setup-persistence";

export interface CanonicalSelection {
	version: 1;
	mode: "legacy" | "canonical";
	migrationId: string;
	repositoryRoot: string;
	storePath: string;
	baseCommit: string;
	selectedAt: string;
}
export interface MigrationShadowReport {
	version: 1;
	migrationId: string;
	commit: string;
	comparedAt: string;
	queries: Array<{ query: string; legacyIds: string[]; canonicalIds: string[]; equal: boolean }>;
	equal: boolean;
}
export async function loadCanonicalSelection(config: Config): Promise<CanonicalSelection | undefined> {
	try {
		const value = JSON.parse(await readFile(join(config.stateRoot, "canonical-runtime.json"), "utf8")) as CanonicalSelection;
		if (value.version !== 1 || !["legacy", "canonical"].includes(value.mode) || !isAbsolute(value.repositoryRoot) || !isAbsolute(value.storePath) || !value.baseCommit) throw new Error("invalid canonical runtime selection");
		return value;
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function shadowPath(config: Config, id: string) { return join(config.stateRoot, "archive-migrations", id, "shadow.json"); }
export async function shadowArchiveMigration(config: Config, id: string, queries: string[]): Promise<MigrationShadowReport> {
	if (!queries.length || queries.length > 100 || queries.some((query) => !query.trim() || query.length > 2_000)) throw new Error("shadow comparison requires 1 to 100 bounded queries");
	const receipt = await readArchiveMigration(config.stateRoot, id);
	if (receipt.status !== "verified" || !receipt.commit) throw new Error("migration must be verified before shadow retrieval");
	const root = join(config.stateRoot, "archive-migrations", id);
	const legacyConfig: Config = { ...config, archiveRoot: receipt.source, providers: undefined, brain: { ...config.brain!, databasePath: join(root, "legacy-shadow.sqlite") } };
	await indexArchive(legacyConfig);
	const repository = new BrainRepository(receipt.target);
	if (await repository.head() !== receipt.commit) throw new Error("brain changed since migration verification");
	const store = await openPgliteBrainStore(join(root, "shadow-projection"));
	try {
		await indexBrainRepository(store, repository);
		const brainId = (await repository.getIdentity()).brainId;
		const results: MigrationShadowReport["queries"] = [];
		for (const query of queries) {
			const legacyIds = [...new Set((await searchArchive(legacyConfig, query, { mode: "keyword", limit: 10 })).map((hit) => hit.manasId))];
			const canonicalIds = (await searchVerifiedHybridBrainRepository(store, repository, query, { brainId, limit: 10, autocut: false })).map((hit) => hit.citation.documentId);
			results.push({ query, legacyIds, canonicalIds, equal: JSON.stringify(legacyIds) === JSON.stringify(canonicalIds) });
		}
		const report: MigrationShadowReport = { version: 1, migrationId: id, commit: receipt.commit, comparedAt: new Date().toISOString(), queries: results, equal: results.every((result) => result.equal) };
		await writeSetupConfiguration(shadowPath(config, id), report);
		return report;
	} finally { await store.close(); }
}
export async function activateCanonicalArchive(config: Config, id: string, expectedCommit: string, acceptShadowDifferences = false): Promise<CanonicalSelection> {
	const receipt = await readArchiveMigration(config.stateRoot, id);
	if (receipt.status !== "verified" || !receipt.commit || expectedCommit !== receipt.commit) throw new Error("canonical cutover requires the verified migration commit");
	const shadow = JSON.parse(await readFile(shadowPath(config, id), "utf8")) as MigrationShadowReport;
	if (shadow.version !== 1 || shadow.migrationId !== id || shadow.commit !== expectedCommit || !shadow.queries.length || (!shadow.equal && !acceptShadowDifferences)) throw new Error("review shadow retrieval differences before explicit cutover");
	const release = await acquireStoreOwnership(join(config.stateRoot, "service"));
	try {
		const repository = new BrainRepository(receipt.target);
		if (await repository.head() !== expectedCommit) throw new Error("brain changed after shadow retrieval");
		for (const file of receipt.files) {
			for (const path of [join(receipt.source, file.path), join(receipt.target, file.path), join(config.stateRoot, "archive-migrations", id, "archive-backup", file.path)]) {
				const hash = createHash("sha256").update(await readFile(path)).digest("hex");
				if (hash !== file.sha256) throw new Error("archive hashes changed before cutover");
			}
		}
		const selection: CanonicalSelection = { version: 1, mode: "canonical", migrationId: id, repositoryRoot: receipt.target, storePath: join(config.stateRoot, "runtime"), baseCommit: expectedCommit, selectedAt: new Date().toISOString() };
		const store = await openPgliteBrainStore(selection.storePath);
		try { await indexBrainRepository(store, repository); } finally { await store.close(); }
		await writeSetupConfiguration(join(config.stateRoot, "canonical-runtime.json"), selection);
		return selection;
	} finally { release(); }
}
export async function rollbackCanonicalArchive(config: Config): Promise<CanonicalSelection> {
	const selection = await loadCanonicalSelection(config);
	if (!selection) throw new Error("no canonical migration selection exists");
	const release = await acquireStoreOwnership(join(config.stateRoot, "service"));
	try {
		const rolledBack = { ...selection, mode: "legacy" as const, selectedAt: new Date().toISOString() };
		await writeSetupConfiguration(join(config.stateRoot, "canonical-runtime.json"), rolledBack);
		return rolledBack;
	} finally { release(); }
}
