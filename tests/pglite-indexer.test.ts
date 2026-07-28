import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const storeModule = ["..", "src", "brain", "store"].join(String.fromCharCode(47));
const indexerModule = ["..", "src", "brain", "pglite-indexer"].join(String.fromCharCode(47));
const repositoryModule = ["..", "src", "brain", "repository"].join(String.fromCharCode(47));
const sourceHealthModule = ["..", "src", "brain", "source-health"].join(String.fromCharCode(47));
const { openPgliteBrainStore } = await import(storeModule);
const { chunkMarkdown, computeProjectionDelta, extractWikiLinks, indexBrainRepository, indexBrainRepositoryIncremental, indexBrainRepositoryIsolated, relatedBrainPages, rerankProjectedSearchResults, resolveBrainCitation, searchBrainRepository, searchExpandedBrainRepository, searchHybridBrainRepository, searchVerifiedHybridBrainRepository, traverseBrainGraph } = await import(indexerModule);
const { indexLocalEmbeddings } = await import(["..", "src", "brain", "local-embeddings"].join(String.fromCharCode(47)));
const { BrainRepository } = await import(repositoryModule);
const { sourceHealth } = await import(sourceHealthModule);
const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("PGLite brain indexing", () => {
	test("computes a deterministic commit-range projection delta", () => {
		const previous = [{ id: "a", path: "a.md", contentHash: "one", revision: "1" }, { id: "b", path: "b.md", contentHash: "two", revision: "1" }, { id: "c", path: "c.md", contentHash: "three", revision: "1" }];
		const target = [{ id: "a", path: "renamed.md", contentHash: "one", revision: "1" }, { id: "b", path: "b.md", contentHash: "new", revision: "2" }, { id: "c", path: "c.md", contentHash: "three", revision: "1", accessLabels: ["team"] }, { id: "d", path: "d.md", contentHash: "four", revision: "1" }];
		expect(computeProjectionDelta(previous, target)).toEqual({ created: ["d"], updated: ["b"], moved: [{ id: "a", from: "a.md", to: "renamed.md" }], deleted: [], restored: [], metadataOnly: ["c"] });
	});
	test("chunks Markdown deterministically at headings with exact offsets", () => {
		const content = "# One\n\nFirst paragraph.\n\n## Two\n\nSecond paragraph.";
		const chunks = chunkMarkdown("page", content, 64);
		expect(chunks.map((chunk: { text: string }) => chunk.text)).toEqual(["# One\n\nFirst paragraph.", "## Two\n\nSecond paragraph."]);
		for (const chunk of chunks) expect(content.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
		expect(chunkMarkdown("page", content, 64)).toEqual(chunks);
	});

	test("projects wiki links into outbound and backlink relationships", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-pglite-links-"));
		roots.push(root);
		const brain = new BrainRepository(join(root, "brain"));
		await brain.initialize();
		await execFile("git", ["-C", brain.root, "config", "user.name", "Test"]);
		await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
		const leaf = await brain.putPage(join("notes", "leaf.md"), "# Leaf");
		const target = await brain.putPage(join("notes", "target.md"), "# Target\n\nSee [[notes/leaf.md]].");
		const source = await brain.putPage(join("notes", "source.md"), "See [[notes/target.md]] and [[notes/target.md]].");
		const store = await openPgliteBrainStore();
		try {
			await indexBrainRepository(store, brain);
			const snapshot = await brain.snapshot();
			expect(extractWikiLinks("[[notes/target.md]] [[notes/target.md]]")).toEqual(["notes/target.md"]);
			expect(await relatedBrainPages(store, "notes/source.md", snapshot.brainId)).toMatchObject([{ path: "notes/target.md", relation: "outbound" }]);
			expect(await relatedBrainPages(store, target.path, snapshot.brainId)).toContainEqual(expect.objectContaining({ path: "notes/source.md", relation: "backlink" }));
			expect(await traverseBrainGraph(store, source.path, snapshot.brainId, 2)).toMatchObject([{ path: "notes/target.md", depth: 1, relation: "outbound", via: source.path }, { path: leaf.path, depth: 2, relation: "outbound", via: target.path }]);
			await brain.deletePage(source.path, source.revision, source.commit);
			await indexBrainRepository(store, brain);
			expect(await relatedBrainPages(store, target.path, snapshot.brainId)).not.toContainEqual(expect.objectContaining({ path: source.path, relation: "backlink" }));
		} finally { await store.close(); }
	});

	test("indexes manifest pages with native full-text search", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-pglite-index-"));
		roots.push(root);
		const brain = new BrainRepository(join(root, "brain"));
		await brain.initialize();
		await execFile("git", ["-C", brain.root, "config", "user.name", "Test"]);
		await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
		const page = await brain.putPage(join("notes", "search.md"), "PostgreSQL hybrid retrieval is local.", undefined, { type: "fixture", externalId: "search", updatedAt: "2025-01-01T00:00:00.000Z", provenance: { sourceType: "fixture", retrievedAt: "2025-01-01T00:00:00.000Z", metadata: { extractor: "plain-text" } } });
		const labels = await brain.setPageAccessLabels(join("notes", "search.md"), ["private"], page.revision, page.commit);
		await writeFile(join(brain.root, "notes", "search.md"), "uncommitted text must not be projected");
		const store = await openPgliteBrainStore();
		try {
			expect(await indexBrainRepository(store, brain)).toMatchObject({ commit: labels.commit, indexed: 1, skippedDeleted: 0 });
			const results = await searchBrainRepository(store, "hybrid postgresql");
			expect(results).toMatchObject([{ path: "notes/search.md" }]);
			expect(typeof results[0]!.citation.chunkId).toBe("string");
			expect(results[0]!.citation.documentRevision).toBe(labels.revision);
			expect(results[0]!.citation.commit).toBe(labels.commit);
			expect(await store.query("SELECT git_commit FROM brain_active_projection_runs WHERE tenant_id = 'local' AND brain_id = $1", [results[0]!.citation.brainId])).toEqual([{ git_commit: labels.commit }]);
			expect(await sourceHealth(store, results[0]!.citation.brainId, "local", new Date("2025-01-01T00:01:00.000Z"))).toEqual([{ sourceType: "fixture", activeDocuments: 1, staleDocuments: 0, chunks: 1, embeddedChunks: 0, embeddingCoverage: 0, extractionCoverage: 1, quarantinedEvents: 0, latestSourceUpdatedAt: "2025-01-01T00:00:00.000Z", lagSeconds: 60 }]);
			expect(await store.query("SELECT source_metadata FROM brain_documents WHERE id = $1", [page.id])).toMatchObject([{ source_metadata: { source: { type: "fixture", externalId: "search", provenance: { sourceType: "fixture", retrievedAt: "2025-01-01T00:00:00.000Z", metadata: { extractor: "plain-text" } } }, sourceRevision: null, visibilityLabels: [] } }]);
			expect(await rerankProjectedSearchResults({ rerank: async () => [{ id: results[0]!.id, score: 0.9 }] }, "hybrid postgresql", results)).toMatchObject([{ id: results[0]!.id, rerankerScore: 0.9 }]);
			expect((await resolveBrainCitation(store, brain, results[0]!.citation)).text).toContain("PostgreSQL hybrid retrieval");
			expect(await searchBrainRepository(store, "uncommitted")).toEqual([]);
			expect((await searchExpandedBrainRepository(store, "postgresql hybrid", 20, results[0]!.citation.brainId)).variants).toEqual(["postgresql hybrid"]);
			expect(await searchBrainRepository(store, "hybrid postgresql", 20, results[0]!.citation.brainId)).toHaveLength(1);
			expect(await searchBrainRepository(store, "hybrid postgresql", 20, "different-brain")).toEqual([]);
			expect(await searchBrainRepository(store, "hybrid postgresql", 20, results[0]!.citation.brainId, [])).toEqual([]);
			expect(await searchBrainRepository(store, "hybrid postgresql", 20, results[0]!.citation.brainId, ["private"])).toHaveLength(1);
			const embeddingProvider = { model: { id: "hybrid-model", dimensions: 2 }, embed: async (texts: string[]) => texts.map((text) => text.includes("PostgreSQL") ? [1, 0] : [0, 1]) };
			await indexLocalEmbeddings(store, embeddingProvider, 32, { tenantId: "local", brainId: results[0]!.citation.brainId });
			const hybrid = await searchHybridBrainRepository(store, "semantic-only", { embeddingProvider, brainId: results[0]!.citation.brainId, limit: 5 });
			expect(Number(hybrid[0]!.explain.recencyScore)).toBeGreaterThan(0);
			expect(hybrid[0]).toMatchObject({ path: "notes/search.md", explain: { semanticScore: expect.any(Number), sourceTier: expect.any(Number), recencyScore: expect.any(Number) } });
			expect((await searchVerifiedHybridBrainRepository(store, brain, "semantic-only", { embeddingProvider, brainId: results[0]!.citation.brainId, limit: 5 }))[0]?.verifiedText).toContain("PostgreSQL hybrid retrieval");
			const projectedLabels = await store.query("SELECT access_labels FROM brain_documents WHERE id = $1", [page.id]) as Array<{ access_labels: string[] }>;
			expect(projectedLabels).toEqual([{ access_labels: ["private"] }]);
			const originalChunks = await store.query("SELECT id FROM brain_chunks WHERE document_id = $1", [page.id]);
			await store.query("UPDATE brain_documents SET tenant_id = $2 WHERE id = $1", [page.id, "tenant-a"]);
			expect(await searchBrainRepository(store, "hybrid postgresql", 20, results[0]!.citation.brainId)).toEqual([]);
			const tenantResults = await searchBrainRepository(store, "hybrid postgresql", 20, results[0]!.citation.brainId, undefined, "tenant-a");
			expect(tenantResults).toHaveLength(1);
			expect(tenantResults[0]!.citation.tenantId).toBe("tenant-a");
			await brain.putPage(join("notes", "second.md"), "a separate committed page");
			expect(await indexBrainRepository(store, brain)).toMatchObject({ indexed: 1, skippedDeleted: 0 });
			expect(await store.query("SELECT id FROM brain_chunks WHERE document_id = $1", [page.id])).toEqual(originalChunks);
		} finally { await store.close(); }
	});

	test("builds an isolated projection and leaves the previous active run readable after a failed build", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-pglite-isolated-"));
		roots.push(root);
		const brain = new BrainRepository(join(root, "brain"));
		await brain.initialize();
		await execFile("git", ["-C", brain.root, "config", "user.name", "Test"]);
		await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
		const firstPage = await brain.putPage("notes/isolated.md", "first projection");
		const store = await openPgliteBrainStore();
		try {
			const first = await indexBrainRepositoryIncremental(store, brain);
			expect(first.projectionRunId).toBeDefined();
			const brainId = (await brain.snapshot()).brainId;
			await brain.putPage(firstPage.path, "second projection", firstPage.revision, first.commit);
			const second = await indexBrainRepositoryIncremental(store, brain, { fromCommit: first.commit });
			expect(second.delta).toMatchObject({ updated: [firstPage.id] });
			expect(((await store.query("SELECT run_id FROM brain_active_projection_runs WHERE brain_id = $1", [brainId])) as Array<{ run_id: string }>)[0]!.run_id).toBe(second.projectionRunId);
			expect(await store.query("SELECT document_id, revision, projected_commit FROM brain_document_revisions WHERE document_id = $1", [firstPage.id])).toContainEqual(expect.objectContaining({ document_id: firstPage.id, revision: expect.any(String), projected_commit: expect.any(String) }));
			const activeBeforeFailure = await store.query("SELECT git_commit FROM brain_active_projection_runs WHERE brain_id = $1", [brainId]) as Array<{ git_commit: string }>;
			const brokenSnapshot = await brain.snapshot();
			const brokenRepository = { snapshot: async () => ({ ...brokenSnapshot, commit: "broken-commit" }), readPage: async () => ({ content: "not the Git bytes" }) };
			await expect(indexBrainRepositoryIsolated(store, brokenRepository)).rejects.toThrow("content hash mismatch");
			expect(await store.query("SELECT git_commit FROM brain_active_projection_runs WHERE brain_id = $1", [brainId])).toEqual(activeBeforeFailure);
			expect((await store.query("SELECT status FROM brain_projection_runs WHERE status = 'failed'")).length).toBe(1);
		} finally { await store.close(); }
	});

	test("carries the committed schema pack through unchanged incremental content", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-pglite-schema-context-"));
		roots.push(root);
		const brain = new BrainRepository(join(root, "brain"));
		await brain.initialize();
		await execFile("git", ["-C", brain.root, "config", "user.name", "Test"]);
		await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
		await brain.putPage("notes/schema-context.md", "schema context remains authoritative");
		const store = await openPgliteBrainStore();
		try {
			const first = await indexBrainRepositoryIncremental(store, brain);
			const originalChunks = await store.query("SELECT id, text_hash FROM brain_chunks WHERE document_id = (SELECT id FROM brain_documents WHERE path = 'notes/schema-context.md')");
			const switched = await brain.setSchemaPack({ id: "legacy", version: "1" }, first.commit);
			const second = await indexBrainRepositoryIncremental(store, brain, { fromCommit: first.commit });
			expect(second.indexed).toBe(0);
			expect(await store.query("SELECT id, text_hash FROM brain_chunks WHERE document_id = (SELECT id FROM brain_documents WHERE path = 'notes/schema-context.md')")).toEqual(originalChunks);
			const result = (await searchBrainRepository(store, "schema context"))[0]!;
			expect(result.citation.schemaPack).toEqual({ id: "legacy", version: "1" });
			expect(await store.query("SELECT source_metadata, projected_commit FROM brain_documents WHERE path = 'notes/schema-context.md'")).toMatchObject([{ source_metadata: { schemaPack: { id: "legacy", version: "1" } }, projected_commit: switched.commit }]);
			expect(await store.query("SELECT metadata FROM brain_graph_nodes WHERE label = 'notes/schema-context.md'")).toMatchObject([{ metadata: { schemaPack: { id: "legacy", version: "1" } } }]);
		} finally { await store.close(); }
	});

	test("incrementally applies moves, metadata, tombstones, restores, and graph invalidation", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-pglite-incremental-"));
		roots.push(root);
		const brain = new BrainRepository(join(root, "brain"));
		await brain.initialize();
		await execFile("git", ["-C", brain.root, "config", "user.name", "Test"]);
		await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
		const source = await brain.putPage("notes/source.md", "[[notes/target.md]] source");
		const target = await brain.putPage("notes/target.md", "target body", undefined, undefined, source.commit);
		const store = await openPgliteBrainStore();
		try {
			const first = await indexBrainRepositoryIncremental(store, brain);
			const originalChunks = await store.query("SELECT id, ordinal, text_hash FROM brain_chunks WHERE document_id = $1 ORDER BY ordinal", [target.id]);
			const moved = await brain.movePage("notes/target.md", "notes/moved.md", target.revision, first.commit);
			const second = await indexBrainRepositoryIncremental(store, brain, { fromCommit: first.commit });
			expect(second.delta).toMatchObject({ moved: [{ id: target.id, from: "notes/target.md", to: "notes/moved.md" }] });
			expect(await store.query("SELECT id, ordinal, text_hash FROM brain_chunks WHERE document_id = $1 ORDER BY ordinal", [target.id])).toEqual(originalChunks);
			expect((await store.query("SELECT count(*)::int AS count FROM brain_graph_edges WHERE from_node_id = $1", [`document:${source.id}`]))[0]!.count).toBe(0);
			const labeled = await brain.setPageAccessLabels("notes/moved.md", ["private"], moved.revision, second.commit);
			const third = await indexBrainRepositoryIncremental(store, brain, { fromCommit: second.commit });
			expect(third.delta).toMatchObject({ metadataOnly: [target.id] });
			expect(await store.query("SELECT id, ordinal, text_hash FROM brain_chunks WHERE document_id = $1 ORDER BY ordinal", [target.id])).toEqual(originalChunks);
			const deleted = await brain.deletePage("notes/moved.md", labeled.revision, third.commit);
			const fourth = await indexBrainRepositoryIncremental(store, brain, { fromCommit: third.commit });
			expect(fourth.delta?.deleted).toContain(target.id);
			expect((await store.query("SELECT deleted_at FROM brain_documents WHERE id = $1", [target.id]))[0]!.deleted_at).not.toBeNull();
			const restored = await brain.restorePage(target.id, "notes/restored.md", deleted.revision, fourth.commit);
			const fifth = await indexBrainRepositoryIncremental(store, brain, { fromCommit: fourth.commit });
			expect(fifth.delta?.restored).toContain(target.id);
			expect(await store.query("SELECT id, path, deleted_at FROM brain_documents WHERE id = $1", [target.id])).toMatchObject([{ id: target.id, path: "notes/restored.md", deleted_at: null }]);
			expect(restored.id).toBe(target.id);
		} finally { await store.close(); }
	});
});
