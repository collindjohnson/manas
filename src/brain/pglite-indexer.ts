import { createHash, randomUUID } from "node:crypto";
import { autocutHybridResults, reciprocalRankFusion, rerankCandidates, type HybridResult, type RankedCandidate } from "./hybrid";
import { semanticSearch } from "./local-embeddings";
import type { EmbeddingProvider } from "./providers";

type Store = {
	query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]>;
	exec(sql: string): Promise<void>;
	transaction<T>(action: (store: Store) => Promise<T>): Promise<T>;
};

type SchemaPackSelection = { id: string; version: string };
type ManifestEntry = { id: string; path: string; contentHash: string; revision: string; deleted?: boolean; stale?: boolean; source?: { type: string; externalId: string; provenance?: { sourceType: string; sourcePath?: string; retrievedAt: string; metadata?: Record<string, string> }; externalRevision?: string; contentHash?: string; extractionMetadata?: Record<string, string>; updatedAt?: string; visibilityLabels?: string[]; managedSections?: string[] }; accessLabels?: string[] };
type Snapshot = { brainId: string; repositoryId: string; commit: string; tenantId?: string; pages: ManifestEntry[]; settings?: { schemaPack?: SchemaPackSelection } };
type Repository = { snapshot(ref?: string): Promise<Snapshot>; readPage(snapshot: Snapshot, id: string): Promise<{ content: string }> };

function digest(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function schemaPack(snapshot: Snapshot): SchemaPackSelection {
	const selected = snapshot.settings?.schemaPack;
	return selected && typeof selected.id === "string" && typeof selected.version === "string" ? { id: selected.id, version: selected.version } : { id: "default", version: "1" };
}
function sourceMetadata(source: ManifestEntry["source"], selectedSchemaPack: SchemaPackSelection): Record<string, unknown> {
	return {
		...(source?.provenance?.metadata ?? {}),
		source: source ?? null,
		extraction: source?.extractionMetadata ?? {},
		sourceContentHash: source?.contentHash ?? null,
		sourceRevision: source?.externalRevision ?? null,
		provenance: source?.provenance ?? null,
		visibilityLabels: source?.visibilityLabels ?? [],
		managedSections: source?.managedSections ?? [],
		schemaPack: selectedSchemaPack,
	};
}

export function extractWikiLinks(content: string): string[] {
	const links = new Set<string>();
	let cursor = 0;
	while (cursor < content.length) {
		const start = content.indexOf("[[", cursor);
		if (start < 0) break;
		const end = content.indexOf("]]", start + 2);
		if (end < 0) break;
		const target = content.slice(start + 2, end).trim();
		if (target && !target.includes("\n")) links.add(target);
		cursor = end + 2;
	}
	return [...links].sort();
}

export interface ProjectedChunk {
	id: string;
	ordinal: number;
	text: string;
	startOffset: number;
	endOffset: number;
	textHash: string;
}

export interface Citation {
	tenantId: string;
	brainId: string;
	documentId: string;
	chunkId: string;
	path: string;
	revision: string;
	documentRevision: string;
	commit: string;
	startOffset: number;
	endOffset: number;
	contentHash: string;
	schemaPack: SchemaPackSelection;
}

export interface ProjectionDelta {
	created: string[];
	updated: string[];
	moved: Array<{ id: string; from: string; to: string }>;
	deleted: string[];
	restored: string[];
	metadataOnly: string[];
}

function manifestMetadata(entry: ManifestEntry): string {
	return JSON.stringify({ revision: entry.revision, path: entry.path, deleted: Boolean(entry.deleted), stale: Boolean(entry.stale), accessLabels: [...(entry.accessLabels ?? [])].sort(), source: entry.source ?? null });
}

export function computeProjectionDelta(previous: ManifestEntry[], target: ManifestEntry[]): ProjectionDelta {
	const before = new Map(previous.map((entry) => [entry.id, entry]));
	const after = new Map(target.map((entry) => [entry.id, entry]));
	const delta: ProjectionDelta = { created: [], updated: [], moved: [], deleted: [], restored: [], metadataOnly: [] };
	for (const entry of target) {
		const old = before.get(entry.id);
		if (!old) { delta.created.push(entry.id); continue; }
		if (old.deleted !== entry.deleted) { if (entry.deleted) delta.deleted.push(entry.id); else delta.restored.push(entry.id); }
		if (old.path !== entry.path) delta.moved.push({ id: entry.id, from: old.path, to: entry.path });
		if (old.contentHash !== entry.contentHash || old.revision !== entry.revision) delta.updated.push(entry.id);
		if (old.contentHash === entry.contentHash && old.revision === entry.revision && manifestMetadata(old) !== manifestMetadata(entry) && old.path === entry.path && old.deleted === entry.deleted) delta.metadataOnly.push(entry.id);
	}
	for (const entry of previous) if (!after.has(entry.id) && !entry.deleted) delta.deleted.push(entry.id);
	for (const key of ["created", "updated", "deleted", "restored", "metadataOnly"] as const) delta[key].sort();
	delta.moved.sort((left, right) => left.id.localeCompare(right.id));
	return delta;
}

export function chunkMarkdown(documentId: string, content: string, maximumChars = 1_200): ProjectedChunk[] {
	if (!Number.isInteger(maximumChars) || maximumChars < 64) throw new Error("invalid chunk maximum");
	const sections: Array<{ start: number; end: number }> = [];
	let start = 0;
	let cursor = 0;
	while (cursor < content.length) {
		const next = content.indexOf("\n", cursor);
		const end = next < 0 ? content.length : next + 1;
		const line = content.slice(cursor, end).trimStart();
		if (cursor > 0 && line.startsWith("#")) { sections.push({ start, end: cursor }); start = cursor; }
		cursor = end;
	}
	sections.push({ start, end: content.length });
	const ranges: Array<{ start: number; end: number }> = [];
	for (const section of sections) {
		let sectionStart = section.start;
		while (sectionStart < section.end && content[sectionStart]!.trim() === "") sectionStart++;
		for (let position = sectionStart; position < section.end;) {
			let end = Math.min(section.end, position + maximumChars);
			if (end < section.end) {
				const breakAt = Math.max(content.lastIndexOf("\n\n", end), content.lastIndexOf("\n", end), content.lastIndexOf(" ", end));
				if (breakAt > position + Math.floor(maximumChars / 3)) end = breakAt;
			}
			while (end > position && content[end - 1]!.trim() === "") end--;
			if (end > position) ranges.push({ start: position, end });
			position = Math.max(end, position + 1);
			while (position < section.end && content[position]!.trim() === "") position++;
		}
	}
	return ranges.map((range, ordinal) => {
		const text = content.slice(range.start, range.end);
		const textHash = digest(text);
		return { id: `${documentId}:${textHash}:${range.start}:${range.end}`, ordinal, text, startOffset: range.start, endOffset: range.end, textHash };
	});
}

export async function indexBrainRepository(store: Store, repository: Repository): Promise<{ commit: string; indexed: number; skippedDeleted: number }> {
	const snapshot = await repository.snapshot();
	const tenantId = snapshot.tenantId ?? "local";
	const selectedSchemaPack = schemaPack(snapshot);
	const runId = randomUUID();
	let activeRunId: string = runId;
	let indexed = 0;
	let skippedDeleted = 0;
	await store.transaction(async (transaction) => {
		const run = await transaction.query<{ id: string }>("INSERT INTO brain_projection_runs (id, tenant_id, brain_id, repository_id, git_commit, status) VALUES ($1, $2, $3, $4, $5, 'running') ON CONFLICT (brain_id, git_commit) DO UPDATE SET status = 'running', started_at = now(), completed_at = NULL RETURNING id", [runId, tenantId, snapshot.brainId, snapshot.repositoryId, snapshot.commit]);
		activeRunId = run[0]?.id ?? runId;
		for (const page of snapshot.pages) {
			if (page.deleted) {
				skippedDeleted += 1;
				await transaction.query("DELETE FROM brain_links WHERE source_document_id = $1", [page.id]);
				await transaction.query("DELETE FROM brain_chunks WHERE document_id = $1", [page.id]);
				await transaction.query("INSERT INTO brain_document_revisions (id, document_id, tenant_id, brain_id, revision, path, content_hash, projected_commit, deleted) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) ON CONFLICT (document_id, revision) DO NOTHING", [page.id + ":" + page.revision, page.id, tenantId, snapshot.brainId, page.revision, page.path, page.contentHash, snapshot.commit]);
				await transaction.query("UPDATE brain_documents SET deleted_at = now(), stale = $3, projected_commit = $2, indexed_at = now() WHERE id = $1", [page.id, snapshot.commit, Boolean(page.stale)]);
				continue;
			}
			const content = (await repository.readPage(snapshot, page.id)).content;
			if (digest(content) !== page.contentHash) throw new Error(`Git snapshot content hash mismatch: ${page.path}`);
			await transaction.query("INSERT INTO brain_document_revisions (id, document_id, tenant_id, brain_id, revision, path, content_hash, projected_commit, deleted) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false) ON CONFLICT (document_id, revision) DO NOTHING", [page.id + ":" + page.revision, page.id, tenantId, snapshot.brainId, page.revision, page.path, page.contentHash, snapshot.commit]);
			const existing = await transaction.query<{ content_hash: string; revision: string; deleted_at: string | null }>(
				"SELECT content_hash, revision, deleted_at FROM brain_documents WHERE id = $1",
				[page.id],
			);
			if (existing[0]?.content_hash === page.contentHash && existing[0].revision === page.revision && existing[0].deleted_at === null) {
				await transaction.query("UPDATE brain_documents SET projected_commit = $2, access_labels = $3::jsonb, tenant_id = $4, source_updated_at = $5, stale = $6, source_metadata = $7::jsonb, indexed_at = now() WHERE id = $1", [page.id, snapshot.commit, JSON.stringify(page.accessLabels ?? []), tenantId, page.source?.updatedAt ?? null, Boolean(page.stale), JSON.stringify(sourceMetadata(page.source, selectedSchemaPack))]);
				continue;
			}
			await transaction.query(
				"INSERT INTO brain_documents (id, path, content_hash, revision, source_type, external_id, tenant_id, brain_id, repository_id, projected_commit, access_labels, source_updated_at, stale, source_metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::jsonb) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path, content_hash = EXCLUDED.content_hash, revision = EXCLUDED.revision, source_type = EXCLUDED.source_type, external_id = EXCLUDED.external_id, tenant_id = EXCLUDED.tenant_id, brain_id = EXCLUDED.brain_id, repository_id = EXCLUDED.repository_id, projected_commit = EXCLUDED.projected_commit, access_labels = EXCLUDED.access_labels, source_updated_at = EXCLUDED.source_updated_at, stale = EXCLUDED.stale, source_metadata = EXCLUDED.source_metadata, deleted_at = NULL, indexed_at = now()",
				[page.id, page.path, page.contentHash, page.revision, page.source?.type ?? null, page.source?.externalId ?? null, tenantId, snapshot.brainId, snapshot.repositoryId, snapshot.commit, JSON.stringify(page.accessLabels ?? []), page.source?.updatedAt ?? null, Boolean(page.stale), JSON.stringify(sourceMetadata(page.source, selectedSchemaPack))],
			);
			await transaction.query("DELETE FROM brain_chunks WHERE document_id = $1", [page.id]);
			await transaction.query("DELETE FROM brain_links WHERE source_document_id = $1", [page.id]);
			for (const targetPath of extractWikiLinks(content)) await transaction.query("INSERT INTO brain_links (tenant_id, brain_id, source_document_id, target_path) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [tenantId, snapshot.brainId, page.id, targetPath]);
			for (const chunk of chunkMarkdown(page.id, content)) await transaction.query(
				"INSERT INTO brain_chunks (id, document_id, ordinal, text, search_vector, start_offset, end_offset, text_hash) VALUES ($1, $2, $3, $4, to_tsvector('simple', $4), $5, $6, $7)",
				[chunk.id, page.id, chunk.ordinal, chunk.text, chunk.startOffset, chunk.endOffset, chunk.textHash],
			);
			indexed += 1;
		}
		await transaction.query("DELETE FROM brain_cache_entries WHERE tenant_id = $1 AND brain_id = $2 AND projected_commit <> $3", [tenantId, snapshot.brainId, snapshot.commit]);
		await transaction.query("UPDATE brain_projection_runs SET status = 'complete', completed_at = now() WHERE id = $1", [activeRunId]);
		await transaction.query("INSERT INTO brain_active_projection_runs (tenant_id, brain_id, run_id, git_commit) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, brain_id) DO UPDATE SET run_id = EXCLUDED.run_id, git_commit = EXCLUDED.git_commit, updated_at = now()", [tenantId, snapshot.brainId, activeRunId, snapshot.commit]);
	});
	return { commit: snapshot.commit, indexed, skippedDeleted };
}

export async function indexBrainRepositoryIsolated(store: Store, repository: Repository): Promise<{ commit: string; indexed: number; skippedDeleted: number; projectionRunId: string }> {
	const snapshot = await repository.snapshot();
	const tenantId = snapshot.tenantId ?? "local";
	const selectedSchemaPack = schemaPack(snapshot);
	const runId = randomUUID();
	let indexed = 0;
	let skippedDeleted = 0;
	await store.query("INSERT INTO brain_projection_runs (id, tenant_id, brain_id, repository_id, git_commit, status) VALUES ($1, $2, $3, $4, $5, 'running')", [runId, tenantId, snapshot.brainId, snapshot.repositoryId, snapshot.commit]);
	try {
		await store.transaction(async (transaction) => {
			for (const page of snapshot.pages) {
				if (page.deleted) skippedDeleted += 1;
				const content = page.deleted ? "" : (await repository.readPage(snapshot, page.id)).content;
				if (!page.deleted && digest(content) !== page.contentHash) throw new Error(`Git snapshot content hash mismatch: ${page.path}`);
				await transaction.query("INSERT INTO brain_projection_documents (run_id, document_id, tenant_id, brain_id, repository_id, path, content_hash, revision, source_type, external_id, access_labels, source_updated_at, stale, source_metadata, deleted) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::jsonb, $15)", [runId, page.id, tenantId, snapshot.brainId, snapshot.repositoryId, page.path, page.contentHash, page.revision, page.source?.type ?? null, page.source?.externalId ?? null, JSON.stringify(page.accessLabels ?? []), page.source?.updatedAt ?? null, Boolean(page.stale), JSON.stringify(sourceMetadata(page.source, selectedSchemaPack)), Boolean(page.deleted)]);
				if (page.deleted) continue;
				for (const targetPath of extractWikiLinks(content)) await transaction.query("INSERT INTO brain_projection_links (run_id, tenant_id, brain_id, source_document_id, target_path) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [runId, tenantId, snapshot.brainId, page.id, targetPath]);
				for (const chunk of chunkMarkdown(page.id, content)) await transaction.query("INSERT INTO brain_projection_chunks (run_id, document_id, id, ordinal, text, start_offset, end_offset, text_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [runId, page.id, chunk.id, chunk.ordinal, chunk.text, chunk.startOffset, chunk.endOffset, chunk.textHash]);
				indexed += 1;
			}
		});
		await store.transaction(async (transaction) => {
			await transaction.query("UPDATE brain_projection_runs SET status = 'complete', completed_at = now() WHERE id = $1 AND status = 'running'", [runId]);
			await transaction.query("INSERT INTO brain_repository_snapshots (id, tenant_id, brain_id, repository_id, git_commit, manifest_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, brain_id, git_commit) DO UPDATE SET manifest_hash = EXCLUDED.manifest_hash", [runId, tenantId, snapshot.brainId, snapshot.repositoryId, snapshot.commit, digest(JSON.stringify(snapshot.pages))]);
			await transaction.query("DELETE FROM brain_cache_entries WHERE tenant_id = $1 AND brain_id = $2 AND projected_commit <> $3", [tenantId, snapshot.brainId, snapshot.commit]);
			await transaction.query("DELETE FROM brain_documents WHERE tenant_id = $1 AND brain_id = $2", [tenantId, snapshot.brainId]);
			await transaction.query("DELETE FROM brain_links WHERE tenant_id = $1 AND brain_id = $2", [tenantId, snapshot.brainId]);
			await transaction.query("DELETE FROM brain_graph_edges WHERE tenant_id = $1 AND brain_id = $2 AND edge_type = 'wiki-link'", [tenantId, snapshot.brainId]);
			await transaction.query("DELETE FROM brain_graph_nodes WHERE tenant_id = $1 AND brain_id = $2 AND node_type = 'document'", [tenantId, snapshot.brainId]);
			await transaction.query("INSERT INTO brain_documents (id, path, content_hash, revision, source_type, external_id, tenant_id, brain_id, repository_id, projected_commit, access_labels, source_updated_at, stale, source_metadata, deleted_at) SELECT document_id, path, content_hash, revision, source_type, external_id, tenant_id, brain_id, repository_id, $2, access_labels, source_updated_at, stale, source_metadata, CASE WHEN deleted THEN now() ELSE NULL END FROM brain_projection_documents WHERE run_id = $1", [runId, snapshot.commit]);
			await transaction.query("INSERT INTO brain_document_revisions (id, document_id, tenant_id, brain_id, revision, path, content_hash, projected_commit, deleted) SELECT document_id || ':' || revision, document_id, tenant_id, brain_id, revision, path, content_hash, $2, deleted FROM brain_projection_documents WHERE run_id = $1 ON CONFLICT (document_id, revision) DO NOTHING", [runId, snapshot.commit]);
			await transaction.query("INSERT INTO brain_chunks (id, document_id, ordinal, text, search_vector, start_offset, end_offset, text_hash) SELECT id, document_id, ordinal, text, to_tsvector('simple', text), start_offset, end_offset, text_hash FROM brain_projection_chunks WHERE run_id = $1", [runId]);
			await transaction.query("INSERT INTO brain_links (tenant_id, brain_id, source_document_id, target_path) SELECT tenant_id, brain_id, source_document_id, target_path FROM brain_projection_links WHERE run_id = $1", [runId]);
			await transaction.query("INSERT INTO brain_graph_nodes (id, tenant_id, brain_id, node_type, external_id, label, metadata) SELECT 'document:' || document_id, tenant_id, brain_id, 'document', document_id, path, jsonb_build_object('deleted', deleted, 'commit', $2::text, 'schemaPack', source_metadata->'schemaPack') FROM brain_projection_documents WHERE run_id = $1 ON CONFLICT (tenant_id, brain_id, node_type, external_id) DO UPDATE SET label = EXCLUDED.label, metadata = EXCLUDED.metadata", [runId, snapshot.commit]);
			await transaction.query("INSERT INTO brain_graph_edges (id, tenant_id, brain_id, from_node_id, to_node_id, edge_type, metadata) SELECT 'wiki:' || l.source_document_id || ':' || l.target_path, l.tenant_id, l.brain_id, 'document:' || l.source_document_id, 'document:' || target.document_id, 'wiki-link', jsonb_build_object('commit', $2::text, 'schemaPack', target.source_metadata->'schemaPack') FROM brain_projection_links l JOIN brain_projection_documents target ON target.run_id = l.run_id AND target.tenant_id = l.tenant_id AND target.brain_id = l.brain_id AND target.path = l.target_path WHERE l.run_id = $1 AND target.deleted = false ON CONFLICT (tenant_id, brain_id, from_node_id, to_node_id, edge_type) DO UPDATE SET metadata = EXCLUDED.metadata", [runId, snapshot.commit]);
			await transaction.query("INSERT INTO brain_active_projection_runs (tenant_id, brain_id, run_id, git_commit) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, brain_id) DO UPDATE SET run_id = EXCLUDED.run_id, git_commit = EXCLUDED.git_commit, updated_at = now()", [tenantId, snapshot.brainId, runId, snapshot.commit]);
		});
		return { commit: snapshot.commit, indexed, skippedDeleted, projectionRunId: runId };
	} catch (error) {
		await store.query("UPDATE brain_projection_runs SET status = 'failed', completed_at = now() WHERE id = $1 AND status = 'running'", [runId]).catch(() => undefined);
		throw error;
	}
}

export async function indexBrainRepositoryIncremental(store: Store, repository: Repository, options: { fromCommit?: string } = {}): Promise<{ commit: string; indexed: number; skippedDeleted: number; projectionRunId: string; delta?: ProjectionDelta }> {
	const target = await repository.snapshot();
	const tenantId = target.tenantId ?? "local";
	const selectedSchemaPack = schemaPack(target);
	const active = await store.query<{ git_commit: string; run_id: string }>("SELECT git_commit, run_id FROM brain_active_projection_runs WHERE tenant_id = $1 AND brain_id = $2", [tenantId, target.brainId]);
	const fromCommit = options.fromCommit ?? active[0]?.git_commit;
	if (!fromCommit) {
		const result = await indexBrainRepositoryIsolated(store, repository);
		return result;
	}
	if (active[0]?.git_commit !== fromCommit) throw new Error("incremental projection base is stale");
	const previous = await repository.snapshot(fromCommit);
	const delta = computeProjectionDelta(previous.pages, target.pages);
	if (target.commit === fromCommit) return { commit: target.commit, indexed: 0, skippedDeleted: target.pages.filter((page) => page.deleted).length, delta, projectionRunId: active[0]!.run_id };
	const changed = new Set([...delta.created, ...delta.updated, ...delta.moved.map((entry) => entry.id), ...delta.deleted, ...delta.restored]);
	const metadataOnly = new Set(delta.metadataOnly);
	const runId = randomUUID();
	let indexed = 0;
	const skippedDeleted = target.pages.filter((page) => page.deleted).length;
	const removed = previous.pages.filter((page) => !target.pages.some((entry) => entry.id === page.id)).map((page) => page.id);
	const replaced = [...new Set([...changed, ...removed])].sort();
	try {
		await store.query("INSERT INTO brain_projection_runs (id, tenant_id, brain_id, repository_id, git_commit, status) VALUES ($1, $2, $3, $4, $5, 'running')", [runId, tenantId, target.brainId, target.repositoryId, target.commit]);
		await store.transaction(async (transaction) => {
			for (const page of target.pages) {
				const needsContentProjection = changed.has(page.id) || metadataOnly.has(page.id);
				if (!needsContentProjection) {
					const copied = await transaction.query<{ document_id: string }>("INSERT INTO brain_projection_documents (run_id, document_id, tenant_id, brain_id, repository_id, path, content_hash, revision, source_type, external_id, access_labels, source_updated_at, stale, source_metadata, deleted) SELECT $1, d.id, d.tenant_id, d.brain_id, d.repository_id, d.path, d.content_hash, d.revision, d.source_type, d.external_id, d.access_labels, d.source_updated_at, d.stale, d.source_metadata || $5::jsonb, (d.deleted_at IS NOT NULL) FROM brain_documents d WHERE d.id = $2 AND d.tenant_id = $3 AND d.brain_id = $4 RETURNING document_id", [runId, page.id, tenantId, target.brainId, JSON.stringify({ schemaPack: selectedSchemaPack })]);
					if (copied.length) {
						await transaction.query("INSERT INTO brain_projection_chunks (run_id, document_id, id, ordinal, text, start_offset, end_offset, text_hash) SELECT $1, c.document_id, c.id, c.ordinal, c.text, c.start_offset, c.end_offset, c.text_hash FROM brain_chunks c JOIN brain_documents d ON d.id = c.document_id WHERE c.document_id = $2 AND d.tenant_id = $3 AND d.brain_id = $4", [runId, page.id, tenantId, target.brainId]);
						await transaction.query("INSERT INTO brain_projection_links (run_id, tenant_id, brain_id, source_document_id, target_path) SELECT $1, l.tenant_id, l.brain_id, l.source_document_id, l.target_path FROM brain_links l WHERE l.source_document_id = $2 AND l.tenant_id = $3 AND l.brain_id = $4", [runId, page.id, tenantId, target.brainId]);
						continue;
					}
				}
				const content = page.deleted ? "" : (await repository.readPage(target, page.id)).content;
				if (!page.deleted && digest(content) !== page.contentHash) throw new Error(`Git snapshot content hash mismatch: ${page.path}`);
				await transaction.query("INSERT INTO brain_projection_documents (run_id, document_id, tenant_id, brain_id, repository_id, path, content_hash, revision, source_type, external_id, access_labels, source_updated_at, stale, source_metadata, deleted) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::jsonb, $15)", [runId, page.id, tenantId, target.brainId, target.repositoryId, page.path, page.contentHash, page.revision, page.source?.type ?? null, page.source?.externalId ?? null, JSON.stringify(page.accessLabels ?? []), page.source?.updatedAt ?? null, Boolean(page.stale), JSON.stringify(sourceMetadata(page.source, selectedSchemaPack)), Boolean(page.deleted)]);
				if (page.deleted) continue;
				if (changed.has(page.id)) indexed += 1;
				for (const targetPath of extractWikiLinks(content)) await transaction.query("INSERT INTO brain_projection_links (run_id, tenant_id, brain_id, source_document_id, target_path) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [runId, tenantId, target.brainId, page.id, targetPath]);
				for (const chunk of chunkMarkdown(page.id, content)) await transaction.query("INSERT INTO brain_projection_chunks (run_id, document_id, id, ordinal, text, start_offset, end_offset, text_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [runId, page.id, chunk.id, chunk.ordinal, chunk.text, chunk.startOffset, chunk.endOffset, chunk.textHash]);
			}
		});
		await store.transaction(async (transaction) => {
			await transaction.query("UPDATE brain_projection_runs SET status = 'complete', completed_at = now() WHERE id = $1 AND status = 'running'", [runId]);
			await transaction.query("INSERT INTO brain_repository_snapshots (id, tenant_id, brain_id, repository_id, git_commit, manifest_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, brain_id, git_commit) DO UPDATE SET manifest_hash = EXCLUDED.manifest_hash", [runId, tenantId, target.brainId, target.repositoryId, target.commit, digest(JSON.stringify(target.pages))]);
			await transaction.query("DELETE FROM brain_cache_entries WHERE tenant_id = $1 AND brain_id = $2 AND projected_commit <> $3", [tenantId, target.brainId, target.commit]);
			for (const id of replaced) {
				// Facts and claims are evidence derived from the projected document.
				// Remove only rows anchored to a changed document; unrelated analysis
				// in the same brain remains durable across an incremental run.
				await transaction.query("DELETE FROM brain_facts WHERE tenant_id = $1 AND brain_id = $2 AND document_id = $3", [tenantId, target.brainId, id]);
				await transaction.query("DELETE FROM brain_claims WHERE tenant_id = $1 AND brain_id = $2 AND document_id = $3", [tenantId, target.brainId, id]);
				await transaction.query("DELETE FROM brain_chunks WHERE document_id = $1", [id]);
				await transaction.query("DELETE FROM brain_links WHERE tenant_id = $1 AND brain_id = $2 AND source_document_id = $3", [tenantId, target.brainId, id]);
				await transaction.query("DELETE FROM brain_documents WHERE tenant_id = $1 AND brain_id = $2 AND id = $3", [tenantId, target.brainId, id]);
			}
			for (const id of replaced) {
				await transaction.query("INSERT INTO brain_documents (id, path, content_hash, revision, source_type, external_id, tenant_id, brain_id, repository_id, projected_commit, access_labels, source_updated_at, stale, source_metadata, deleted_at) SELECT document_id, path, content_hash, revision, source_type, external_id, tenant_id, brain_id, repository_id, $2, access_labels, source_updated_at, stale, source_metadata, CASE WHEN deleted THEN now() ELSE NULL END FROM brain_projection_documents WHERE run_id = $1 AND document_id = $3", [runId, target.commit, id]);
				await transaction.query("INSERT INTO brain_chunks (id, document_id, ordinal, text, search_vector, start_offset, end_offset, text_hash) SELECT id, document_id, ordinal, text, to_tsvector('simple', text), start_offset, end_offset, text_hash FROM brain_projection_chunks WHERE run_id = $1 AND document_id = $2", [runId, id]);
				await transaction.query("INSERT INTO brain_links (tenant_id, brain_id, source_document_id, target_path) SELECT tenant_id, brain_id, source_document_id, target_path FROM brain_projection_links WHERE run_id = $1 AND source_document_id = $2", [runId, id]);
			}
			for (const id of metadataOnly) await transaction.query("UPDATE brain_documents d SET path = s.path, content_hash = s.content_hash, revision = s.revision, source_type = s.source_type, external_id = s.external_id, repository_id = s.repository_id, projected_commit = $3, access_labels = s.access_labels, source_updated_at = s.source_updated_at, stale = s.stale, source_metadata = s.source_metadata, indexed_at = now() FROM brain_projection_documents s WHERE s.run_id = $1 AND s.document_id = $2 AND d.id = s.document_id AND d.tenant_id = s.tenant_id AND d.brain_id = s.brain_id", [runId, id, target.commit]);
			await transaction.query("UPDATE brain_documents d SET projected_commit = $2, source_metadata = s.source_metadata, indexed_at = now() FROM brain_projection_documents s WHERE s.run_id = $1 AND d.id = s.document_id AND d.tenant_id = s.tenant_id AND d.brain_id = s.brain_id", [runId, target.commit]);
			await transaction.query("INSERT INTO brain_document_revisions (id, document_id, tenant_id, brain_id, revision, path, content_hash, projected_commit, deleted) SELECT document_id || ':' || revision, document_id, tenant_id, brain_id, revision, path, content_hash, $2, deleted FROM brain_projection_documents WHERE run_id = $1 ON CONFLICT (document_id, revision) DO NOTHING", [runId, target.commit]);
			await transaction.query("DELETE FROM brain_graph_edges WHERE tenant_id = $1 AND brain_id = $2 AND edge_type = 'wiki-link'", [tenantId, target.brainId]);
			await transaction.query("DELETE FROM brain_graph_nodes WHERE tenant_id = $1 AND brain_id = $2 AND node_type = 'document'", [tenantId, target.brainId]);
			await transaction.query("INSERT INTO brain_graph_nodes (id, tenant_id, brain_id, node_type, external_id, label, metadata) SELECT 'document:' || id, tenant_id, brain_id, 'document', id, path, jsonb_build_object('deleted', deleted_at IS NOT NULL, 'commit', $3::text, 'schemaPack', source_metadata->'schemaPack') FROM brain_documents WHERE tenant_id = $1 AND brain_id = $2 ON CONFLICT (tenant_id, brain_id, node_type, external_id) DO UPDATE SET label = EXCLUDED.label, metadata = EXCLUDED.metadata", [tenantId, target.brainId, target.commit]);
			await transaction.query("INSERT INTO brain_graph_edges (id, tenant_id, brain_id, from_node_id, to_node_id, edge_type, metadata) SELECT 'wiki:' || l.source_document_id || ':' || l.target_path, l.tenant_id, l.brain_id, 'document:' || l.source_document_id, 'document:' || target.id, 'wiki-link', jsonb_build_object('commit', $3::text, 'schemaPack', target.source_metadata->'schemaPack') FROM brain_links l JOIN brain_documents target ON target.tenant_id = l.tenant_id AND target.brain_id = l.brain_id AND target.path = l.target_path AND target.deleted_at IS NULL WHERE l.tenant_id = $1 AND l.brain_id = $2 ON CONFLICT (tenant_id, brain_id, from_node_id, to_node_id, edge_type) DO UPDATE SET metadata = EXCLUDED.metadata", [tenantId, target.brainId, target.commit]);
			await transaction.query("INSERT INTO brain_active_projection_runs (tenant_id, brain_id, run_id, git_commit) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, brain_id) DO UPDATE SET run_id = EXCLUDED.run_id, git_commit = EXCLUDED.git_commit, updated_at = now()", [tenantId, target.brainId, runId, target.commit]);
		});
		return { commit: target.commit, indexed, skippedDeleted, delta, projectionRunId: runId };
	} catch (error) {
		await store.query("UPDATE brain_projection_runs SET status = 'failed', completed_at = now() WHERE id = $1 AND status = 'running'", [runId]).catch(() => undefined);
		throw error;
	}
}

export async function relatedBrainPages(store: Store, path: string, brainId: string, tenantId = "local", allowedAccessLabels?: string[]): Promise<Array<{ id: string; path: string; relation: "outbound" | "backlink" }>> {
	if (!path || !brainId || !tenantId) throw new Error("invalid related-page scope");
	const labels = allowedAccessLabels === undefined ? null : JSON.stringify([...new Set(allowedAccessLabels)].sort());
	return store.query("SELECT d.id, d.path, 'outbound' AS relation FROM brain_links l JOIN brain_documents source ON source.id = l.source_document_id JOIN brain_documents d ON d.path = l.target_path AND d.tenant_id = l.tenant_id AND d.brain_id = l.brain_id WHERE l.tenant_id = $1 AND l.brain_id = $2 AND source.path = $3 AND source.deleted_at IS NULL AND d.deleted_at IS NULL AND ($4::jsonb IS NULL OR d.access_labels <@ $4::jsonb) UNION ALL SELECT source.id, source.path, 'backlink' AS relation FROM brain_links l JOIN brain_documents source ON source.id = l.source_document_id WHERE l.tenant_id = $1 AND l.brain_id = $2 AND l.target_path = $3 AND source.deleted_at IS NULL AND ($4::jsonb IS NULL OR source.access_labels <@ $4::jsonb) ORDER BY relation, path", [tenantId, brainId, path, labels]);
}

export async function traverseBrainGraph(store: Store, path: string, brainId: string, maximumDepth = 2, maximumNodes = 100, tenantId = "local", allowedAccessLabels?: string[]): Promise<Array<{ id: string; path: string; depth: number; relation: "outbound" | "backlink"; via: string }>> {
	if (!path || !brainId || !tenantId || !Number.isInteger(maximumDepth) || maximumDepth < 1 || maximumDepth > 5 || !Number.isInteger(maximumNodes) || maximumNodes < 1 || maximumNodes > 500) throw new Error("invalid graph traversal scope");
	const visited = new Set<string>([path]);
	const found: Array<{ id: string; path: string; depth: number; relation: "outbound" | "backlink"; via: string }> = [];
	let frontier = [path];
	for (let depth = 1; depth <= maximumDepth && frontier.length && found.length < maximumNodes; depth++) {
		const next: string[] = [];
		for (const current of frontier.sort()) {
			const related = await relatedBrainPages(store, current, brainId, tenantId, allowedAccessLabels);
			for (const page of related) {
				if (visited.has(page.path)) continue;
				visited.add(page.path);
				found.push({ ...page, depth, via: current });
				next.push(page.path);
				if (found.length >= maximumNodes) break;
			}
			if (found.length >= maximumNodes) break;
		}
		frontier = next;
	}
	return found;
}

export type ProjectedSearchResult = { id: string; path: string; text: string; rank: number; citation: Citation };

export interface HybridProjectionSearchOptions {
	limit?: number;
	brainId?: string;
	tenantId?: string;
	allowedAccessLabels?: string[];
	embeddingProvider?: EmbeddingProvider;
	rerankerProvider?: { rerank(query: string, documents: Array<{ id: string; text: string }>): Promise<Array<{ id: string; score: number }>> };
	autocut?: boolean;
}

export type HybridProjectedSearchResult = ProjectedSearchResult & Pick<HybridResult, "score" | "explain" | "lexicalRank" | "semanticRank">;

export async function searchBrainRepository(store: Store, query: string, limit = 20, brainId?: string, allowedAccessLabels?: string[], tenantId = "local"): Promise<ProjectedSearchResult[]> {
	if (brainId !== undefined && !brainId) throw new Error("invalid brain search scope");
	if (allowedAccessLabels !== undefined && (!Array.isArray(allowedAccessLabels) || allowedAccessLabels.some((label) => !label || typeof label !== "string"))) throw new Error("invalid access label scope");
	const rows = await store.query<ProjectedSearchResult & { chunk_id: string }>(
		"SELECT d.id, d.path, c.id AS chunk_id, c.text, json_build_object('tenantId', d.tenant_id, 'brainId', d.brain_id, 'documentId', d.id, 'chunkId', c.id, 'path', d.path, 'revision', d.revision, 'documentRevision', d.revision, 'commit', d.projected_commit, 'startOffset', c.start_offset, 'endOffset', c.end_offset, 'contentHash', c.text_hash, 'schemaPack', d.source_metadata->'schemaPack') AS citation, ts_rank_cd(c.search_vector, plainto_tsquery('simple', $1)) AS rank FROM brain_chunks c JOIN brain_documents d ON d.id = c.document_id WHERE d.deleted_at IS NULL AND d.tenant_id = $3 AND ($4::text IS NULL OR d.brain_id = $4) AND ($5::jsonb IS NULL OR d.access_labels <@ $5::jsonb) AND c.search_vector @@ plainto_tsquery('simple', $1) ORDER BY rank DESC, d.path ASC LIMIT $2",
		[query, limit, tenantId, brainId ?? null, allowedAccessLabels === undefined ? null : JSON.stringify([...new Set(allowedAccessLabels)].sort())],
	);
	return rows.map((row) => ({ ...row, citation: { ...row.citation, chunkId: row.chunk_id, documentRevision: row.citation.revision, schemaPack: row.citation.schemaPack ?? { id: "default", version: "1" } } }));
}

export async function searchExpandedBrainRepository(store: Store, query: string, limit = 20, brainId?: string, allowedAccessLabels?: string[], tenantId = "local"): Promise<{ variants: string[]; results: ProjectedSearchResult[] }> {
	const hybridModule = await import([".", "hybrid"].join(String.fromCharCode(47)));
	const variants = hybridModule.expandLocalQuery(query);
	const scores = new Map<string, { result: ProjectedSearchResult; score: number }>();
	for (const variant of variants) {
		const candidates = await searchBrainRepository(store, variant, limit, brainId, allowedAccessLabels, tenantId);
		candidates.forEach((result, index) => {
			const current = scores.get(result.id);
			const score = 1 / (60 + index + 1);
			scores.set(result.id, { result, score: (current?.score ?? 0) + score });
		});
	}
	return { variants, results: [...scores.values()].sort((left, right) => right.score - left.score || left.result.path.localeCompare(right.result.path) || left.result.id.localeCompare(right.result.id)).slice(0, limit).map(({ result, score }) => ({ ...result, rank: score })) };
}

async function projectedChunkById(store: Store, id: string, tenantId: string, brainId?: string): Promise<ProjectedSearchResult | undefined> {
	const rows = await store.query<ProjectedSearchResult & { chunk_id: string }>(
		"SELECT d.id, d.path, c.id AS chunk_id, c.text, json_build_object('tenantId', d.tenant_id, 'brainId', d.brain_id, 'documentId', d.id, 'chunkId', c.id, 'path', d.path, 'revision', d.revision, 'documentRevision', d.revision, 'commit', d.projected_commit, 'startOffset', c.start_offset, 'endOffset', c.end_offset, 'contentHash', c.text_hash, 'schemaPack', d.source_metadata->'schemaPack') AS citation FROM brain_chunks c JOIN brain_documents d ON d.id = c.document_id WHERE c.id = $1 AND d.tenant_id = $2 AND ($3::text IS NULL OR d.brain_id = $3) AND d.deleted_at IS NULL",
		[id, tenantId, brainId ?? null],
	);
	const row = rows[0];
	if (!row) return undefined;
	return { ...row, citation: { ...row.citation, chunkId: row.chunk_id, documentRevision: row.citation.revision, schemaPack: row.citation.schemaPack ?? { id: "default", version: "1" } }, rank: 0 };
}

function sourceTier(sourceType: string | null): number {
	return sourceType === "manual" || sourceType === null ? 0.02 : sourceType === "filesystem" ? 0.015 : 0.01;
}

function candidate(result: ProjectedSearchResult, signals: Partial<RankedCandidate> = {}): RankedCandidate {
	return { id: result.citation.chunkId, documentId: result.citation.documentId, path: result.path, text: result.text, ...signals };
}

async function hybridSignals(store: Store, results: ProjectedSearchResult[], tenantId: string, brainId?: string): Promise<Map<string, { sourceType: string | null; sourceUpdatedAt: string | null }>> {
	const ids = [...new Set(results.map((result) => result.citation.chunkId))];
	if (!ids.length) return new Map();
	const idPlaceholders = ids.map((_, index) => `$${index + 1}`).join(", ");
	const rows = await store.query<{ chunk_id: string; source_type: string | null; source_updated_at: string | Date | null }>(
		`SELECT c.id AS chunk_id, d.source_type, d.source_updated_at FROM brain_chunks c JOIN brain_documents d ON d.id = c.document_id WHERE c.id IN (${idPlaceholders}) AND d.tenant_id = $${ids.length + 1} AND ($${ids.length + 2}::text IS NULL OR d.brain_id = $${ids.length + 2}) AND d.deleted_at IS NULL`,
		[...ids, tenantId, brainId ?? null],
	);
	return new Map(rows.map((row) => [row.chunk_id, { sourceType: row.source_type, sourceUpdatedAt: row.source_updated_at === null ? null : new Date(row.source_updated_at).toISOString() }]));
}

function recencySignals(results: ProjectedSearchResult[], signals: Map<string, { sourceType: string | null; sourceUpdatedAt: string | null }>): Map<string, number> {
	const timestamps = results.map((result) => Date.parse(signals.get(result.citation.chunkId)?.sourceUpdatedAt ?? "")).filter(Number.isFinite);
	if (!timestamps.length) return new Map(results.map((result) => [result.citation.chunkId, 0]));
	const oldest = Math.min(...timestamps);
	const newest = Math.max(...timestamps);
	const range = newest - oldest;
	return new Map(results.map((result) => {
		const timestamp = Date.parse(signals.get(result.citation.chunkId)?.sourceUpdatedAt ?? "");
		const normalized = Number.isFinite(timestamp) ? range === 0 ? 1 : (timestamp - oldest) / range : 0;
		return [result.citation.chunkId, normalized * 0.02];
	}));
}

/** Executes lexical, vector, graph, source, and recency signals with verified-result compatibility. */
export async function searchHybridBrainRepository(store: Store, query: string, options: HybridProjectionSearchOptions = {}): Promise<HybridProjectedSearchResult[]> {
	const limit = options.limit ?? 20;
	const tenantId = options.tenantId ?? "local";
	if (!query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 100 || !tenantId.trim()) throw new Error("invalid hybrid search options");
	const brainId = options.brainId;
	const candidateLimit = Math.min(100, Math.max(limit * 4, 20));
	const lexical = await searchBrainRepository(store, query, candidateLimit, brainId, options.allowedAccessLabels, tenantId);
	const semantic: ProjectedSearchResult[] = [];
	if (options.embeddingProvider) {
		const vectors = await semanticSearch(store, options.embeddingProvider, query, candidateLimit, { tenantId, brainId: brainId ?? "local", allowedAccessLabels: options.allowedAccessLabels });
		for (const vector of vectors) {
			const result = await projectedChunkById(store, vector.id, tenantId, brainId);
			if (result) semantic.push(result);
		}
	}
	const all = new Map<string, ProjectedSearchResult>([...lexical, ...semantic].map((result) => [result.citation.chunkId, result]));
	const graphBoost = new Map<string, number>();
	for (const seed of [...lexical, ...semantic].slice(0, 8)) {
		for (const related of await relatedBrainPages(store, seed.path, brainId ?? seed.citation.brainId, tenantId, options.allowedAccessLabels)) {
			const relatedChunk = await store.query<{ id: string }>("SELECT c.id FROM brain_chunks c JOIN brain_documents d ON d.id = c.document_id WHERE d.id = $1 AND d.tenant_id = $2 AND d.brain_id = $3 AND d.deleted_at IS NULL ORDER BY c.ordinal LIMIT 1", [related.id, tenantId, brainId ?? seed.citation.brainId]);
			if (relatedChunk[0]) graphBoost.set(relatedChunk[0].id, Math.max(graphBoost.get(relatedChunk[0].id) ?? 0, 0.025));
			if (relatedChunk[0] && !all.has(relatedChunk[0].id)) {
				const result = await projectedChunkById(store, relatedChunk[0].id, tenantId, brainId);
				if (result) all.set(result.citation.chunkId, result);
			}
		}
	}
	const signals = await hybridSignals(store, [...all.values()], tenantId, brainId);
	const recency = recencySignals([...all.values()], signals);
	const rankedSignals = (result: ProjectedSearchResult): Pick<RankedCandidate, "sourceTier" | "pageStrength" | "recencyScore"> => ({
		sourceTier: sourceTier(signals.get(result.citation.chunkId)?.sourceType ?? null),
		pageStrength: Math.min(0.01, result.text.length / 100_000),
		recencyScore: recency.get(result.citation.chunkId) ?? 0,
	});
	const lexicalCandidates = lexical.map((result) => candidate(result, rankedSignals(result)));
	const semanticCandidates = semantic.map((result) => candidate(result, rankedSignals(result)));
	const fused = reciprocalRankFusion(lexicalCandidates, semanticCandidates).map((result) => {
		const nextGraphBoost = Math.max(result.graphBoost ?? 0, graphBoost.get(result.id) ?? 0);
		const explain = { ...result.explain, graphBoost: nextGraphBoost };
		return { ...result, graphBoost: nextGraphBoost, score: explain.lexicalScore + explain.semanticScore + explain.graphBoost + explain.sourceTier + explain.recencyScore + explain.pageStrength, explain };
	});
	const withGraphOnly: HybridResult[] = [...fused, ...[...graphBoost.keys()].filter((id) => !fused.some((result) => result.id === id)).map((id) => {
		const result = all.get(id)!;
		const base = rankedSignals(result);
		const explain = { lexicalScore: 0, semanticScore: 0, graphBoost: graphBoost.get(id) ?? 0, sourceTier: base.sourceTier ?? 0, recencyScore: base.recencyScore ?? 0, pageStrength: base.pageStrength ?? 0 };
		return { ...candidate(result, { graphBoost: explain.graphBoost, ...base }), score: explain.graphBoost + explain.sourceTier + explain.recencyScore + explain.pageStrength, explain };
	})];
	let ranked: HybridResult[] = withGraphOnly;
	if (options.rerankerProvider && ranked.length) {
		const reranked = await rerankCandidates(options.rerankerProvider, query, ranked);
		const order = new Map(reranked.map((result, index) => [result.id, index]));
		ranked = ranked.slice().sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
	}
	const final = options.autocut === false ? ranked.slice(0, limit) : autocutHybridResults(ranked, { maximum: limit });
	return final.map((result, index) => {
		const source = all.get(result.id);
		if (!source) throw new Error("hybrid result lost its projected citation");
		return { ...source, rank: index + 1, score: result.score, explain: result.explain, lexicalRank: result.lexicalRank, semanticRank: result.semanticRank };
	});
}

export async function searchVerifiedHybridBrainRepository(store: Store, repository: Repository, query: string, options: HybridProjectionSearchOptions = {}): Promise<Array<HybridProjectedSearchResult & { verifiedText: string }>> {
	const results = await searchHybridBrainRepository(store, query, options);
	return Promise.all(results.map(async (result) => ({ ...result, verifiedText: (await resolveBrainCitation(store, repository, result.citation)).text })));
}

export async function searchVerifiedBrainRepository(store: Store, repository: Repository, query: string, limit = 20, brainId?: string, allowedAccessLabels?: string[], tenantId = "local"): Promise<Array<ProjectedSearchResult & { verifiedText: string }>> {
	const results = await searchBrainRepository(store, query, limit, brainId, allowedAccessLabels, tenantId);
	const verified = await Promise.all(results.map(async (result) => {
		const resolved = await resolveBrainCitation(store, repository, result.citation);
		return { ...result, verifiedText: resolved.text };
	}));
	return verified;
}

export async function rerankProjectedSearchResults(provider: { rerank(query: string, documents: Array<{ id: string; text: string }>): Promise<Array<{ id: string; score: number }>> }, query: string, results: ProjectedSearchResult[]): Promise<Array<ProjectedSearchResult & { rerankerScore: number }>> {
	const hybridModule = await import([".", "hybrid"].join(String.fromCharCode(47)));
	return hybridModule.rerankCandidates(provider, query, results.map((result) => ({ ...result, documentId: result.citation.documentId })));
}

export async function resolveBrainCitation(store: Store, repository: Repository, citation: Citation): Promise<{ text: string; citation: Citation }> {
	const chunkId = citation.chunkId;
	const active = await store.query<{ git_commit: string }>(
		"SELECT git_commit FROM brain_active_projection_runs WHERE tenant_id = $1 AND brain_id = $2",
		[citation.tenantId, citation.brainId],
	);
	if (!active[0] || active[0].git_commit !== citation.commit) throw new Error("citation does not match the active projection");
	const rows = await store.query<{ id: string; path: string; revision: string; tenant_id: string; brain_id: string; projected_commit: string | null; chunk_id: string; source_metadata: unknown }>(
		"SELECT d.id, d.path, d.revision, d.tenant_id, d.brain_id, d.projected_commit, d.source_metadata, c.id AS chunk_id FROM brain_documents d JOIN brain_chunks c ON c.document_id = d.id WHERE d.id = $1 AND d.tenant_id = $2 AND d.brain_id = $3 AND c.id = $4 AND d.deleted_at IS NULL",
		[citation.documentId, citation.tenantId, citation.brainId, chunkId],
	);
	const row = rows[0];
	if (!row || row.path !== citation.path || row.revision !== citation.revision || citation.documentRevision !== citation.revision || row.tenant_id !== citation.tenantId || row.brain_id !== citation.brainId || row.projected_commit !== citation.commit || row.chunk_id !== chunkId) throw new Error("citation does not match the active projection");
	const metadata = typeof row.source_metadata === "string" ? JSON.parse(row.source_metadata) as Record<string, unknown> : row.source_metadata as Record<string, unknown>;
	const projectedSchemaPack = metadata?.schemaPack as { id?: unknown; version?: unknown } | undefined;
	if (projectedSchemaPack?.id !== citation.schemaPack.id || projectedSchemaPack?.version !== citation.schemaPack.version) throw new Error("citation schema pack does not match the active projection");
	const snapshot = await repository.snapshot(citation.commit);
	if (snapshot.brainId !== citation.brainId) throw new Error("citation brain does not match Git snapshot");
	const page = await repository.readPage(snapshot, citation.documentId);
	if (citation.startOffset < 0 || citation.endOffset < citation.startOffset || citation.endOffset > page.content.length) throw new Error("citation offsets are invalid");
	const text = page.content.slice(citation.startOffset, citation.endOffset);
	if (digest(text) !== citation.contentHash) throw new Error("citation bytes do not match projected content");
	return { text, citation: { ...citation, chunkId, documentRevision: citation.revision } };
}
