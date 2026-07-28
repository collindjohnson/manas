type Store = { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]> };

export type SourceHealth = {
	sourceType: string;
	activeDocuments: number;
	staleDocuments: number;
	chunks: number;
	embeddedChunks: number;
	embeddingCoverage: number;
	extractionCoverage: number;
	quarantinedEvents: number;
	latestSourceUpdatedAt?: string;
	lagSeconds?: number;
};

export async function sourceHealth(store: Store, brainId: string, tenantId = "local", now = new Date()): Promise<SourceHealth[]> {
	if (!brainId || !tenantId) throw new Error("invalid source health scope");
	const [rows, quarantines] = await Promise.all([store.query<{ source_type: string | null; active_documents: string; extracted_documents: string; stale_documents: string; chunks: string; embedded_chunks: string; latest_source_updated_at: string | Date | null }>(
		"SELECT d.source_type, COUNT(DISTINCT d.id) FILTER (WHERE d.deleted_at IS NULL)::text AS active_documents, COUNT(DISTINCT d.id) FILTER (WHERE d.deleted_at IS NULL AND d.source_metadata ? 'extractor')::text AS extracted_documents, COUNT(DISTINCT d.id) FILTER (WHERE d.stale)::text AS stale_documents, COUNT(c.id)::text AS chunks, COUNT(c.id) FILTER (WHERE c.embedding IS NOT NULL)::text AS embedded_chunks, MAX(d.source_updated_at) AS latest_source_updated_at FROM brain_documents d LEFT JOIN brain_chunks c ON c.document_id = d.id WHERE d.tenant_id = $1 AND d.brain_id = $2 GROUP BY d.source_type ORDER BY d.source_type NULLS LAST",
		[tenantId, brainId],
	), store.query<{ subject_id: string; count: string }>("SELECT subject_id, COUNT(*)::text AS count FROM brain_audit_events WHERE tenant_id = $1 AND action = 'source.quarantined' AND subject_id IS NOT NULL GROUP BY subject_id", [tenantId])]);
	const quarantinedBySource = new Map(quarantines.map((row) => [row.subject_id, Number(row.count)]));
	return rows.map((row) => {
		const latestSourceUpdatedAt = row.latest_source_updated_at ? new Date(row.latest_source_updated_at).toISOString() : undefined;
		const chunks = Number(row.chunks);
		const activeDocuments = Number(row.active_documents);
		return { sourceType: row.source_type ?? "manual", activeDocuments, staleDocuments: Number(row.stale_documents), chunks, embeddedChunks: Number(row.embedded_chunks), embeddingCoverage: chunks ? Number(row.embedded_chunks) / chunks : 1, extractionCoverage: activeDocuments ? Number(row.extracted_documents) / activeDocuments : 1, quarantinedEvents: quarantinedBySource.get(row.source_type ?? "manual") ?? 0, latestSourceUpdatedAt, lagSeconds: latestSourceUpdatedAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(latestSourceUpdatedAt)) / 1000)) : undefined };
	});
}
