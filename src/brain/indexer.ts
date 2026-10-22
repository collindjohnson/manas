import { relative } from "node:path";
import { configuredArchiveEmbeddingProvider, indexArchiveEmbeddings } from "@manas-brain-archive-embeddings";
import type { Database } from "bun:sqlite";
import { scanArchive, parseFrontmatter } from "../archive";
import type { Config } from "../config";
import { sha256 } from "../utils";
import { withIndexLock } from "../state";
import { openBrainDatabase, inTransaction } from "./database";
import { chunkDocument } from "./chunker";
import { canonicalRemotePayload } from "./payload";
import { replaceDocumentGraph } from "./graph";
import {
	DELETE_DOCUMENT,
	INSERT_CHUNK,
	INSERT_DOCUMENT,
	INSERT_FTS,
	SELECT_DOCUMENT_IDS,
} from "./schema";

export interface IndexResult {
	scanned: number;
	indexed: number;
	skipped: number;
	chunks: number;
	deferred: string[];
	localStatus: "complete" | "failed";
	remoteStatus: "complete" | "degraded" | "pending" | "disabled";
}

type PayloadRow = {
	id: string;
	text: string;
	contextual_prefix: string;
	start_offset: number;
	end_offset: number;
	document_id: string;
	role?: string;
	provider: string;
	project?: string;
	repository?: string;
	workspace?: string;
	relative_path: string;
	source_path?: string;
	created_at?: string;
	updated_at?: string;
};

function isRetryableRemoteFailure(error: unknown): boolean {
	return (
		Boolean(error) &&
		typeof error === "object" &&
		(error as { retryable?: unknown }).retryable === true
	);
}

function payloadFor(row: PayloadRow) {
	return canonicalRemotePayload({
		id: row.id,
		text: row.text,
		contextualPrefix: row.contextual_prefix,
		startOffset: row.start_offset,
		endOffset: row.end_offset,
		documentId: row.document_id,
		role: row.role,
		provider: row.provider,
		project: row.project,
		repository: row.repository,
		workspace: row.workspace,
		relativePath: row.relative_path,
		sourcePath: row.source_path,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
}
function repairCollectionCheckpoints(
	database: Database,
	collection: string,
): void {
	const rows = database
		.prepare(
			"SELECT c.id, c.text, c.contextual_prefix, c.start_offset, c.end_offset, c.document_id, c.role, d.provider, d.project, d.repository, d.workspace, d.relative_path, d.source_path, d.created_at, d.updated_at FROM chunks c JOIN documents d ON d.manas_id = c.document_id",
		)
		.all() as PayloadRow[];
	for (const row of rows) {
		const hash = payloadFor(row).hash;
		database
			.prepare(
				"INSERT INTO remote_chunk_checkpoints (collection_name, chunk_id, payload_hash, status) VALUES (?, ?, ?, 'pending') ON CONFLICT(collection_name, chunk_id) DO UPDATE SET status = CASE WHEN remote_chunk_checkpoints.payload_hash <> excluded.payload_hash THEN 'pending' ELSE remote_chunk_checkpoints.status END, payload_hash = excluded.payload_hash, last_error = CASE WHEN remote_chunk_checkpoints.payload_hash <> excluded.payload_hash THEN NULL ELSE remote_chunk_checkpoints.last_error END",
			)
			.run(collection, row.id, hash);
	}
}
function deleteDocument(
	database: Database,
	manasId: string,
	collection: string,
	retainedIds = new Set<string>(),
): void {
	const ids = database
		.prepare("SELECT id FROM chunks WHERE document_id = ?")
		.all(manasId) as Array<{ id: string }>;
	for (const { id } of ids)
		if (!retainedIds.has(id))
			database
				.prepare(
					"INSERT OR IGNORE INTO remote_tombstones (chunk_id, collection_name, requested_at) VALUES (?, ?, ?)",
				)
				.run(id, collection, new Date().toISOString());
	database
		.prepare(
			"DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
		)
		.run(manasId);
	database.prepare(DELETE_DOCUMENT).run(manasId);
}

export async function indexArchive(
	config: Config,
	rebuild = false,
): Promise<IndexResult> {
	const brain = config.brain;
	if (!brain) throw new Error("brain configuration is unavailable");
	const localEmbeddingProvider = configuredArchiveEmbeddingProvider(config);
	return withIndexLock(config.stateRoot, async () => {
		const database = await openBrainDatabase(brain.databasePath);
		let runId: number | undefined;
		try {
			runId = Number(
				database
					.prepare(
						"INSERT INTO index_runs (mode, started_at, status, collection_name, local_status, remote_status) VALUES (?, ?, 'running', ?, 'running', 'pending')",
					)
					.run(
						rebuild ? "rebuild" : "incremental",
						new Date().toISOString(),
						brain.zeroEntropyCollection,
					).lastInsertRowid,
			);
			const scan = await scanArchive(config.archiveRoot);
			// A partial or ambiguous scan must never reconcile deletions against the
			// authoritative local index. scanArchive reports malformed frontmatter,
			// duplicate IDs, and duplicate source mappings as warnings.
			if (scan.warnings.length)
				throw new Error(
					`archive is not safe to index: ${scan.warnings.join("; ")}`,
				);
			const deferred: string[] = [];
			let indexed = 0;
			let skipped = 0;
			let chunks = 0;
			const currentIds = new Set(
				scan.documents.map((document) => document.manasId),
			);
			for (const row of database.prepare(SELECT_DOCUMENT_IDS).all() as Array<{
				manas_id: string;
			}>)
				if (!currentIds.has(row.manas_id))
					inTransaction(database, () =>
						deleteDocument(
							database,
							row.manas_id,
							brain.zeroEntropyCollection,
						),
					);
			for (const document of scan.documents) {
				const prior = database
					.prepare(
						"SELECT body_hash, frontmatter_hash FROM documents WHERE manas_id = ?",
					)
					.get(document.manasId) as {
					body_hash?: string;
					frontmatter_hash?: string;
				} | null;
				const frontmatterHash = sha256(document.frontmatter);
				if (
					!rebuild &&
					prior?.body_hash === document.bodyHash &&
					prior.frontmatter_hash === frontmatterHash
				) {
					skipped++;
					continue;
				}
				const values =
					parseFrontmatter(document.frontmatter + "\n" + document.body)
						?.values ?? {};
				const documentChunks = chunkDocument(document, {
					targetChars: brain.chunkTargetChars,
					maxChars: brain.chunkMaxChars,
				});
				inTransaction(database, () => {
					// Only old IDs absent from the desired document are tombstoned. Retained
					// IDs may be re-upserted in this transaction and must never be deleted.
					if (prior)
						deleteDocument(
							database,
							document.manasId,
							brain.zeroEntropyCollection,
							new Set(documentChunks.map((chunk) => chunk.id)),
						);
					database
						.prepare(INSERT_DOCUMENT)
						.run(
							document.manasId,
							relative(config.archiveRoot, document.path),
							document.provider,
							values.kind ?? null,
							document.sourceId ?? null,
							document.sourcePath ?? null,
							document.title ?? null,
							values.project ?? null,
							values.repository ?? null,
							values.workspace_path ?? null,
							values.original_created_at ?? null,
							values.original_updated_at ?? null,
							frontmatterHash,
							document.bodyHash,
							new Date().toISOString(),
						);
					for (const chunk of documentChunks) {
						database
							.prepare(INSERT_CHUNK)
							.run(
								chunk.id,
								chunk.documentId,
								chunk.ordinal,
								chunk.role ?? null,
								chunk.startOffset,
								chunk.endOffset,
								chunk.text,
								chunk.textHash,
								chunk.contextualPrefix,
								chunk.sizeEstimate,
							);
						database
							.prepare(INSERT_FTS)
							.run(
								chunk.id,
								chunk.text,
								document.title ?? "",
								values.project ?? "",
								values.repository ?? "",
								document.provider,
							);
						const payloadHash = canonicalRemotePayload({
							id: chunk.id,
							text: chunk.text,
							contextualPrefix: chunk.contextualPrefix,
							startOffset: chunk.startOffset,
							endOffset: chunk.endOffset,
							documentId: chunk.documentId,
							role: chunk.role,
							provider: document.provider,
							project:
								typeof values.project === "string" ? values.project : undefined,
							repository:
								typeof values.repository === "string"
									? values.repository
									: undefined,
							workspace:
								typeof values.workspace_path === "string"
									? values.workspace_path
									: undefined,
							relativePath: relative(config.archiveRoot, document.path),
							sourcePath:
								typeof values.source_path === "string"
									? values.source_path
									: undefined,
							createdAt:
								typeof values.original_created_at === "string"
									? values.original_created_at
									: undefined,
							updatedAt:
								typeof values.original_updated_at === "string"
									? values.original_updated_at
									: undefined,
						}).hash;
						database
							.prepare(
								"DELETE FROM remote_tombstones WHERE collection_name = ? AND chunk_id = ?",
							)
							.run(brain.zeroEntropyCollection, chunk.id);
						database
							.prepare(
								"INSERT INTO remote_chunk_checkpoints (collection_name, chunk_id, payload_hash, status) VALUES (?, ?, ?, 'pending') ON CONFLICT(collection_name, chunk_id) DO UPDATE SET payload_hash = excluded.payload_hash, status = CASE WHEN remote_chunk_checkpoints.payload_hash = excluded.payload_hash THEN remote_chunk_checkpoints.status ELSE 'pending' END, last_error = CASE WHEN remote_chunk_checkpoints.payload_hash = excluded.payload_hash THEN remote_chunk_checkpoints.last_error ELSE NULL END",
							)
							.run(brain.zeroEntropyCollection, chunk.id, payloadHash);
					}
					replaceDocumentGraph(database, {
						manasId: document.manasId,
						provider: document.provider,
						project: values.project,
						repository: values.repository,
						workspace: values.workspace_path,
						sourcePath: values.source_path,
					});
				});
				indexed++;
				chunks += documentChunks.length;
			}
			let localStatus: "complete" | "failed" = "complete";
			let remoteStatus: "complete" | "degraded" | "pending" | "disabled" = "disabled";
			let outstanding = 0;
			if (localEmbeddingProvider) {
				try {
					await indexArchiveEmbeddings(database, localEmbeddingProvider, brain.zeroEntropyBatchSize);
				} catch (error) {
					localStatus = "failed";
					deferred.push(error instanceof Error ? `local embedding indexing failed: ${error.message}` : "local embedding indexing failed");
				}
			} else {
				deferred.push("semantic search is unavailable: configure a local embedding model in providers.embedding");
			}
			database
				.prepare(
					"UPDATE index_runs SET finished_at = ?, status = ?, documents_indexed = ?, chunks_indexed = ?, documents_scanned = ?, remote_pending = ?, local_status = ?, remote_status = ?, summary = ? WHERE id = ?",
				)
				.run(
					new Date().toISOString(),
					localStatus === "complete" ? "complete" : "degraded",
					indexed,
					chunks,
					scan.documents.length,
					outstanding,
					localStatus,
					remoteStatus,
					"local reconciliation completed",
					runId,
				);
			return {
				scanned: scan.documents.length,
				indexed,
				skipped,
				chunks,
				deferred: [...new Set(deferred)],
				localStatus,
				remoteStatus,
			};
		} catch {
			const error = new Error("indexing failed");
			if (runId !== undefined)
				database
					.prepare(
						"UPDATE index_runs SET finished_at = ?, status = 'failed', local_status = 'failed', remote_status = ?, summary = ? WHERE id = ?",
					)
					.run(
						new Date().toISOString(),
						localEmbeddingProvider ? "disabled" : "pending",
						error instanceof Error
							? error.message.replace(/[\r\n]/g, " ").slice(0, 500)
							: "indexing failed",
						runId,
					);
			throw error;
		} finally {
			database.close();
		}
	});
}
