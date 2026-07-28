import { indexBrainRepositoryIncremental, indexBrainRepositoryIsolated, searchVerifiedBrainRepository, type Citation } from "../brain/pglite-indexer";
import { indexLocalEmbeddings } from "../brain/local-embeddings";

type Store = Parameters<typeof indexBrainRepositoryIsolated>[0];
type Repository = Parameters<typeof indexBrainRepositoryIsolated>[1];

type MutationRepository = Repository & {
	putPage(path: string, content: string, expectedRevision?: string, source?: unknown, expectedHead?: string): Promise<{ id: string; path: string; revision: string; commit: string }>;
	movePage(path: string, target: string, expectedRevision: string, expectedHead?: string): Promise<{ id: string; path: string; revision: string; commit: string }>;
	setPageAccessLabels(path: string, labels: string[], expectedRevision: string, expectedHead?: string): Promise<{ id: string; path: string; revision: string; commit: string }>;
	deletePage(path: string, expectedRevision: string, expectedHead?: string): Promise<{ id: string; path: string; revision: string; commit: string }>;
	restorePage(id: string, path: string, expectedRevision: string, expectedHead?: string): Promise<{ id: string; path: string; revision: string; commit: string }>;
};

export interface ProjectionContractResult {
	commit: string;
	activeCommit: string;
	indexed: number;
	revisionCount: number;
	results: Array<{ path: string; text: string; verifiedText: string; citation: Pick<Citation, "tenantId" | "brainId" | "documentId" | "chunkId" | "revision" | "documentRevision" | "commit" | "startOffset" | "endOffset" | "contentHash"> }>;
}

export async function runProjectionContract(store: Store, repository: Repository): Promise<ProjectionContractResult> {
	const snapshot = await repository.snapshot();
	const selectedSchemaPack = snapshot.settings?.schemaPack ?? { id: "default", version: "1" };
	const projection = await indexBrainRepositoryIsolated(store, repository);
	if (projection.commit !== snapshot.commit || projection.indexed < 1) throw new Error("projection contract did not activate the target commit");
	const active = await store.query<{ git_commit: string }>("SELECT git_commit FROM brain_active_projection_runs WHERE tenant_id = $1 AND brain_id = $2", [snapshot.tenantId ?? "local", snapshot.brainId]);
	if (active[0]?.git_commit !== snapshot.commit) throw new Error("projection contract active pointer is stale");
	const results = await searchVerifiedBrainRepository(store, repository, "parity", 20, snapshot.brainId, undefined, snapshot.tenantId ?? "local");
	if (!results.length) throw new Error("projection contract search returned no result");
	for (const result of results) {
		if (!result.verifiedText || result.citation.commit !== snapshot.commit || result.citation.tenantId !== (snapshot.tenantId ?? "local") || result.citation.brainId !== snapshot.brainId) throw new Error("projection contract citation is not verified");
		if (result.citation.schemaPack.id !== selectedSchemaPack.id || result.citation.schemaPack.version !== selectedSchemaPack.version) throw new Error("projection contract schema-pack citation is stale");
	}
	const projectedMetadata = await store.query<{ source_metadata: unknown }>("SELECT source_metadata FROM brain_documents WHERE tenant_id = $1 AND brain_id = $2 AND projected_commit = $3", [snapshot.tenantId ?? "local", snapshot.brainId, snapshot.commit]);
	if (!projectedMetadata.some((row) => { const metadata = typeof row.source_metadata === "string" ? JSON.parse(row.source_metadata) as Record<string, unknown> : row.source_metadata as Record<string, unknown>; const pack = metadata?.schemaPack as Record<string, unknown> | undefined; return pack?.id === selectedSchemaPack.id && pack?.version === selectedSchemaPack.version; })) throw new Error("projection contract did not persist schema-pack metadata");
	const graphMetadata = await store.query<{ metadata: unknown }>("SELECT metadata FROM brain_graph_nodes WHERE tenant_id = $1 AND brain_id = $2 AND node_type = 'document'", [snapshot.tenantId ?? "local", snapshot.brainId]);
	if (!graphMetadata.some((row) => { const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) as Record<string, unknown> : row.metadata as Record<string, unknown>; const pack = metadata?.schemaPack as Record<string, unknown> | undefined; return pack?.id === selectedSchemaPack.id && pack?.version === selectedSchemaPack.version; })) throw new Error("projection contract did not persist graph schema-pack metadata");
	const revisions = await store.query<{ count: number }>("SELECT count(*)::int AS count FROM brain_document_revisions WHERE tenant_id = $1 AND brain_id = $2 AND projected_commit = $3", [snapshot.tenantId ?? "local", snapshot.brainId, snapshot.commit]);
	return {
		commit: snapshot.commit,
		activeCommit: active[0]!.git_commit,
		indexed: projection.indexed,
		revisionCount: revisions[0]?.count ?? 0,
		results: results.map((result) => ({
			path: result.path,
			text: result.text,
			verifiedText: result.verifiedText,
			citation: {
				tenantId: result.citation.tenantId,
				brainId: result.citation.brainId,
				documentId: result.citation.documentId,
				chunkId: result.citation.chunkId,
				revision: result.citation.revision,
				documentRevision: result.citation.documentRevision,
				commit: result.citation.commit,
				startOffset: result.citation.startOffset,
				endOffset: result.citation.endOffset,
				contentHash: result.citation.contentHash,
			},
		})),
	};
}

export interface ProjectionMutationContractResult {
	commit: string;
	created: string[];
	moved: string;
	metadataOnly: string;
	deleted: string;
	restored: string;
	stableChunkIds: string[];
	verifiedText: string;
}

/**
 * Runs the commit-range mutation matrix against the same repository/store
 * contract used by both PGLite and PostgreSQL. The assertions intentionally
 * inspect only normalized projection state so the two engines can be compared
 * without depending on driver-specific result shapes.
 */
export async function runProjectionMutationContract(store: Store, repository: MutationRepository, fromCommit: string): Promise<ProjectionMutationContractResult> {
	const target = await repository.putPage("notes/projection-target.md", "projection target", undefined, undefined, fromCommit);
	const source = await repository.putPage("notes/projection-source.md", "[[notes/projection-target.md]] projection source", undefined, undefined, target.commit);
	const created = await indexBrainRepositoryIncremental(store, repository, { fromCommit });
	if (!created.delta?.created.includes(target.id) || !created.delta.created.includes(source.id)) throw new Error("projection mutation contract did not record creates");
	const createdChunks = await store.query<{ id: string }>("SELECT id FROM brain_chunks WHERE document_id = $1 ORDER BY ordinal", [target.id]);
	if (!createdChunks.length) throw new Error("projection mutation contract did not create target chunks");
	const createdSnapshot = await repository.snapshot(created.commit);
	await store.query("INSERT INTO brain_facts (id, tenant_id, brain_id, subject, predicate, object_value, document_id, chunk_id, confidence) VALUES ($1, $2, $3, 'projection', 'status', 'active', $4, $5, 0.8)", [`${target.id}:fact`, "local", createdSnapshot.brainId, target.id, createdChunks[0]!.id]);
	await store.query("INSERT INTO brain_claims (id, tenant_id, brain_id, fact_id, claim, status, confidence, document_id, chunk_id) VALUES ($1, $2, $3, $4, 'projection is active', 'active', 0.8, $5, $6)", [`${target.id}:claim`, "local", createdSnapshot.brainId, `${target.id}:fact`, target.id, createdChunks[0]!.id]);
	const embeddingProvider = { model: { id: "projection-contract-local", dimensions: 2 }, embed: async (texts: string[]) => texts.map((text) => text.includes("projection") ? [1, 0] : [0, 1]) };
	await indexLocalEmbeddings(store, embeddingProvider, 8, { tenantId: createdSnapshot.tenantId ?? "local", brainId: createdSnapshot.brainId });

	const moved = await repository.movePage(target.path, "notes/projection-moved.md", target.revision, created.commit);
	const movedRun = await indexBrainRepositoryIncremental(store, repository, { fromCommit: created.commit });
	if (!movedRun.delta?.moved.some((entry) => entry.id === target.id && entry.from === target.path && entry.to === moved.path)) throw new Error("projection mutation contract did not record move");
	const movedChunks = await store.query<{ id: string }>("SELECT id FROM brain_chunks WHERE document_id = $1 ORDER BY ordinal", [target.id]);
	if (JSON.stringify(movedChunks) !== JSON.stringify(createdChunks)) throw new Error("projection mutation contract changed chunk IDs during move");
	if ((await store.query("SELECT id FROM brain_facts WHERE document_id = $1", [target.id])).length || (await store.query("SELECT id FROM brain_claims WHERE document_id = $1", [target.id])).length) throw new Error("projection mutation contract retained stale fact or claim evidence");
	if ((await store.query("SELECT chunk_id FROM brain_chunk_embeddings WHERE chunk_id = $1", [createdChunks[0]!.id])).length) throw new Error("projection mutation contract retained stale embeddings");

	const labeled = await repository.setPageAccessLabels(moved.path, ["private"], moved.revision, movedRun.commit);
	const metadataRun = await indexBrainRepositoryIncremental(store, repository, { fromCommit: movedRun.commit });
	if (!metadataRun.delta?.metadataOnly.includes(target.id)) throw new Error("projection mutation contract did not record metadata-only change");
	const metadataChunks = await store.query<{ id: string }>("SELECT id FROM brain_chunks WHERE document_id = $1 ORDER BY ordinal", [target.id]);
	if (JSON.stringify(metadataChunks) !== JSON.stringify(createdChunks)) throw new Error("projection mutation contract rebuilt metadata-only chunks");

	const deleted = await repository.deletePage(labeled.path, labeled.revision, metadataRun.commit);
	const deletedRun = await indexBrainRepositoryIncremental(store, repository, { fromCommit: metadataRun.commit });
	if (!deletedRun.delta?.deleted.includes(target.id)) throw new Error("projection mutation contract did not record tombstone");
	const deletedDocument = await store.query<{ deleted_at: string | null }>("SELECT deleted_at FROM brain_documents WHERE id = $1", [target.id]);
	if (!deletedDocument[0]?.deleted_at) throw new Error("projection mutation contract did not persist tombstone");
	if ((await store.query("SELECT id FROM brain_graph_edges WHERE from_node_id = $1 OR to_node_id = $1", [`document:${target.id}`])).length) throw new Error("projection mutation contract retained deleted graph edges");

	const restored = await repository.restorePage(target.id, "notes/projection-restored.md", deleted.revision, deletedRun.commit);
	const restoredRun = await indexBrainRepositoryIncremental(store, repository, { fromCommit: deletedRun.commit });
	if (!restoredRun.delta?.restored.includes(target.id)) throw new Error("projection mutation contract did not record restore");
	const unchanged = await indexBrainRepositoryIncremental(store, repository, { fromCommit: restoredRun.commit });
	if (unchanged.indexed !== 0 || unchanged.delta?.created.length || unchanged.delta?.updated.length || unchanged.delta?.moved.length || unchanged.delta?.deleted.length || unchanged.delta?.restored.length || unchanged.delta?.metadataOnly.length) throw new Error("projection mutation contract rebuilt an unchanged commit");
	await expectStaleProjectionBase(store, repository, fromCommit);
	const finalSnapshot = await repository.snapshot(restoredRun.commit);
	const results = await searchVerifiedBrainRepository(store, repository, "projection target", 20, finalSnapshot.brainId, undefined, finalSnapshot.tenantId ?? "local");
	const result = results.find((item) => item.citation.documentId === target.id);
	if (!result || result.verifiedText !== "projection target" || result.citation.commit !== restoredRun.commit || result.citation.path !== restored.path) throw new Error("projection mutation contract citation does not resolve to restored Git bytes");
	const activeBeforeFailure = await store.query<{ git_commit: string }>("SELECT git_commit FROM brain_active_projection_runs WHERE tenant_id = $1 AND brain_id = $2", [finalSnapshot.tenantId ?? "local", finalSnapshot.brainId]);
	const brokenRepository = { snapshot: async () => ({ ...finalSnapshot, commit: "broken-projection-commit" }), readPage: async () => ({ content: "not the committed Git bytes" }) };
	await indexBrainRepositoryIsolated(store, brokenRepository).then(() => { throw new Error("projection mutation contract activated a broken isolated run"); }, (error: unknown) => {
		if (!(error instanceof Error) || !error.message.includes("content hash mismatch")) throw error;
	});
	const activeAfterFailure = await store.query<{ git_commit: string }>("SELECT git_commit FROM brain_active_projection_runs WHERE tenant_id = $1 AND brain_id = $2", [finalSnapshot.tenantId ?? "local", finalSnapshot.brainId]);
	if (JSON.stringify(activeAfterFailure) !== JSON.stringify(activeBeforeFailure)) throw new Error("projection mutation contract switched the active run after an interrupted build");
	return { commit: restoredRun.commit, created: created.delta.created, moved: target.id, metadataOnly: target.id, deleted: target.id, restored: target.id, stableChunkIds: createdChunks.map((row) => row.id), verifiedText: result.verifiedText };
}

async function expectStaleProjectionBase(store: Store, repository: Repository, staleCommit: string): Promise<void> {
	await indexBrainRepositoryIncremental(store, repository, { fromCommit: staleCommit }).then(() => { throw new Error("projection mutation contract accepted a stale base"); }, (error: unknown) => {
		if (!(error instanceof Error) || !error.message.includes("incremental projection base is stale")) throw error;
	});
}
