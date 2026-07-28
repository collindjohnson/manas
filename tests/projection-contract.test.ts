import { describe, expect, test } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BrainRepository } from "../src/brain/repository";
import { indexBrainRepositoryIsolated, searchBrainRepository } from "../src/brain/pglite-indexer";
import { openPgliteBrainStore } from "../src/brain/store";
import { runProjectionContract, runProjectionMutationContract } from "../src/parity/projection-contract";
import { setScopedCache } from "../src/brain/analytics";

const execFile = promisify(execFileCallback);

describe("shared projection contract", () => {
	test("runs isolated activation, revisions, tenant scope, and exact citations on PGLite", async () => {
		const root = await mkdtemp(join(tmpdir(), "projection-contract-"));
		const store = await openPgliteBrainStore(join(root, "projection"));
		try {
			const repository = new BrainRepository(join(root, "brain"));
			await repository.initialize();
			await execFile("git", ["-C", repository.root, "config", "user.name", "Projection Contract"]);
			await execFile("git", ["-C", repository.root, "config", "user.email", "projection-contract@example.invalid"]);
			await repository.putPage("notes/parity.md", "Parity projection citation contract.");
			const result = await runProjectionContract(store, repository);
			const citation = result.results[0]!.citation;
			const brainId = citation.brainId;
			const documentId = citation.documentId;
			expect(result).toMatchObject({ activeCommit: result.commit, indexed: 1, revisionCount: 1 });
			expect(result.results[0]).toMatchObject({ path: "notes/parity.md", text: "Parity projection citation contract.", verifiedText: "Parity projection citation contract." });
			expect(citation).toMatchObject({ tenantId: "local", brainId: expect.any(String), documentId: expect.any(String), contentHash: expect.any(String), commit: result.commit });
			expect((await store.query("SELECT count(*)::int AS count FROM brain_repository_snapshots WHERE git_commit = $1", [result.commit]))[0]!.count).toBe(1);
			expect((await store.query("SELECT count(*)::int AS count FROM brain_graph_nodes WHERE brain_id = $1 AND node_type = 'document'", [brainId]))[0]!.count).toBe(1);
			expect(await searchBrainRepository(store, "parity", 20, result.results[0]!.citation.brainId, undefined, "tenant-b")).toEqual([]);
			await expect((await store.query("SELECT count(*)::int AS count FROM brain_documents WHERE tenant_id = $1", ["tenant-b"]))[0]!.count).toBe(0);
			await setScopedCache(store, { tenantId: "local", brainId, cacheKey: "search", projectedCommit: result.commit, schemaVersion: "17", modelFingerprint: "local", value: { ids: [documentId] } });
			const mutation = await runProjectionMutationContract(store, repository, result.commit);
			expect(mutation).toMatchObject({ moved: expect.any(String), metadataOnly: expect.any(String), deleted: expect.any(String), restored: expect.any(String), stableChunkIds: [expect.any(String)], verifiedText: "projection target" });
			await repository.putPage("notes/second.md", "A second parity document.");
			await indexBrainRepositoryIsolated(store, repository);
			expect((await store.query("SELECT count(*)::int AS count FROM brain_cache_entries WHERE tenant_id = $1 AND brain_id = $2", ["local", brainId]))[0]!.count).toBe(0);
		} finally { await store.close(); await rm(root, { recursive: true, force: true }); }
	});
});
