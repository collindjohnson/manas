import { describe, expect, test } from "bun:test";
import { openPgliteBrainStore } from "../src/brain/store";
import { getScopedCache, invalidateScopedCache, recordClaim, recordFact, recordTimelineEvent, refreshEmbeddingCoverage, setScopedCache } from "../src/brain/analytics";

describe("durable analytics state", () => {
	test("persists scoped coverage, cache, facts, claims, and timelines", async () => {
		const store = await openPgliteBrainStore();
		try {
			await store.exec("INSERT INTO brain_documents (id, path, content_hash, revision, tenant_id, brain_id) VALUES ('analytics-doc', 'analytics.md', 'hash', 'rev', 'tenant-a', 'brain-a')");
			await store.exec("INSERT INTO brain_chunks (id, document_id, ordinal, text, search_vector, embedding_model) VALUES ('analytics-chunk', 'analytics-doc', 0, 'analytics', to_tsvector('simple', 'analytics'), 'model-a')");
			expect(await refreshEmbeddingCoverage(store, { tenantId: "tenant-a", brainId: "brain-a", modelFingerprint: "model-a" })).toMatchObject({ totalChunks: 1, coveredChunks: 0 });
			const cache = await setScopedCache(store, { tenantId: "tenant-a", brainId: "brain-a", cacheKey: "query", projectedCommit: "commit-a", schemaPack: { id: "legacy", version: "1" }, modelFingerprint: "model-a", value: { ids: ["analytics-doc"] } });
			expect(cache.schemaVersion).toBe("legacy@1");
			expect(await getScopedCache(store, { tenantId: "tenant-a", brainId: "brain-a", cacheKey: "query", projectedCommit: "commit-a", schemaPack: { id: "legacy", version: "1" }, modelFingerprint: "model-a" })).toMatchObject({ id: cache.id, schemaVersion: "legacy@1", schemaPack: { id: "legacy", version: "1" }, value: { ids: ["analytics-doc"] } });
			expect(await getScopedCache(store, { tenantId: "tenant-b", brainId: "brain-a", cacheKey: "query", projectedCommit: "commit-a", schemaVersion: "17", modelFingerprint: "model-a" })).toBeUndefined();
			const fact = await recordFact(store, { tenantId: "tenant-a", brainId: "brain-a", subject: "project", predicate: "status", objectValue: "active", confidence: 0.9, schemaPack: { id: "legacy", version: "1" } });
			expect(fact.metadata).toMatchObject({ schemaPack: { id: "legacy", version: "1" } });
			expect(await recordClaim(store, { tenantId: "tenant-a", brainId: "brain-a", factId: fact.id, claim: "Project is active", status: "active", confidence: 0.9, schemaPack: { id: "legacy", version: "1" } })).toMatchObject({ factId: fact.id, metadata: { schemaPack: { id: "legacy", version: "1" } } });
			expect(await recordTimelineEvent(store, { tenantId: "tenant-a", brainId: "brain-a", subject: "project", eventAt: "2026-07-27T00:00:00.000Z", label: "started", schemaPack: { id: "legacy", version: "1" } })).toMatchObject({ subject: "project", metadata: { schemaPack: { id: "legacy", version: "1" } } });
			expect(await invalidateScopedCache(store, { tenantId: "tenant-a", brainId: "brain-a", projectedCommit: "commit-a" })).toBe(1);
		} finally { await store.close(); }
	});
});
