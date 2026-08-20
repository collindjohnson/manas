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
	createZeroEntropyClient,
	resolveZeroEntropyApiKey,
} from "./zeroentropy";
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
			// Collection checkpoints are independent. A collection-name change starts a
			// safe reconciliation for the new collection without deleting prior history.
			repairCollectionCheckpoints(database, brain.zeroEntropyCollection);
			const key = await resolveZeroEntropyApiKey(
				brain.keychainService,
				brain.keychainAccount,
			);
			if (!key)
				deferred.push(
					"semantic search is unavailable: ZeroEntropy credential is not configured",
				);
			else
				try {
					const client = createZeroEntropyClient({
						baseUrl: brain.zeroEntropyBaseUrl,
						collection: brain.zeroEntropyCollection,
						apiKey: key,
						timeoutMs: brain.requestTimeoutMs,
					});
					await client.ensureCollection();
					const pending = database
						.prepare(
							"SELECT c.id, c.text, c.contextual_prefix, c.start_offset, c.end_offset, c.document_id, c.role, d.provider, d.project, d.repository, d.workspace, d.relative_path, d.source_path, d.created_at, d.updated_at FROM remote_chunk_checkpoints r JOIN chunks c ON c.id = r.chunk_id JOIN documents d ON d.manas_id = c.document_id WHERE r.collection_name = ? AND (r.status = 'pending' OR (r.status = 'failed' AND r.next_retry_at IS NOT NULL AND r.next_retry_at <= ?)) ORDER BY r.chunk_id",
						)
						.all(
							brain.zeroEntropyCollection,
							new Date().toISOString(),
						) as PayloadRow[];
					for (const chunk of pending) {
						try {
							const payload = payloadFor(chunk);
							await client.upsert([
								{
									id: payload.id,
									text: payload.text,
									metadata: payload.metadata,
								},
							]);
							// Checkpoint every accepted document immediately: later failures are resumable.
							database
								.prepare(
									"UPDATE remote_chunk_checkpoints SET status = 'uploaded', last_upserted_at = ?, last_error = NULL, next_retry_at = NULL, attempts = attempts + 1 WHERE collection_name = ? AND chunk_id = ?",
								)
								.run(
									new Date().toISOString(),
									brain.zeroEntropyCollection,
									chunk.id,
								);
						} catch (error) {
							const message = "remote upload failed";
							const attempts =
								Number(
									(
										database
											.prepare(
												"SELECT attempts FROM remote_chunk_checkpoints WHERE collection_name = ? AND chunk_id = ?",
											)
											.get(brain.zeroEntropyCollection, chunk.id) as {
											attempts: number;
										}
									).attempts,
								) + 1;
							const delay = isRetryableRemoteFailure(error)
								? Math.min(
										10_000,
										(brain.retryBackoffMs ?? 250) *
											2 ** Math.max(0, attempts - 1),
									)
								: undefined;
							database
								.prepare(
									"UPDATE remote_chunk_checkpoints SET status = 'failed', attempts = ?, last_error = ?, next_retry_at = ? WHERE collection_name = ? AND chunk_id = ?",
								)
								.run(
									attempts,
									message,
									delay === undefined
										? null
										: new Date(Date.now() + delay).toISOString(),
									brain.zeroEntropyCollection,
									chunk.id,
								);
							deferred.push(message);
						}
					}
					const deadline = Date.now() + (brain.remotePollDurationMs ?? 30_000);
					while (client.documentStatus) {
						const uploaded = database
							.prepare(
								"SELECT chunk_id FROM remote_chunk_checkpoints WHERE collection_name = ? AND status = 'uploaded'",
							)
							.all(brain.zeroEntropyCollection) as Array<{ chunk_id: string }>;
						if (!uploaded.length) break;
						const states = await client.documentStatus(
							uploaded.map((row) => row.chunk_id),
						);
						for (const row of uploaded) {
							const state = states.get(row.chunk_id);
							const checked = new Date().toISOString();
							if (state === "indexed")
								database
									.prepare(
										"UPDATE remote_chunk_checkpoints SET status = 'indexed', last_checked_at = ?, last_error = NULL WHERE collection_name = ? AND chunk_id = ?",
									)
									.run(checked, brain.zeroEntropyCollection, row.chunk_id);
							else if (
								state === "parsing_failed" ||
								state === "indexing_failed"
							) {
								const delay = Math.min(10_000, brain.retryBackoffMs ?? 250);
								database
									.prepare(
										"UPDATE remote_chunk_checkpoints SET status = 'failed', last_checked_at = ?, last_error = ?, next_retry_at = ? WHERE collection_name = ? AND chunk_id = ?",
									)
									.run(
										checked,
										state === "parsing_failed"
											? "remote parsing failed"
											: "remote indexing failed",
										new Date(Date.now() + delay).toISOString(),
										brain.zeroEntropyCollection,
										row.chunk_id,
									);
							} else
								database
									.prepare(
										"UPDATE remote_chunk_checkpoints SET last_checked_at = ? WHERE collection_name = ? AND chunk_id = ?",
									)
									.run(checked, brain.zeroEntropyCollection, row.chunk_id);
						}
						if (Date.now() >= deadline) break;
						await new Promise((resolve) =>
							setTimeout(resolve, brain.remotePollIntervalMs ?? 1_000),
						);
					}
					const deletions = database
						.prepare(
							"SELECT chunk_id FROM remote_tombstones WHERE collection_name = ? AND (next_retry_at IS NULL OR next_retry_at <= ?)",
						)
						.all(
							brain.zeroEntropyCollection,
							new Date().toISOString(),
						) as Array<{ chunk_id: string }>;
					for (const { chunk_id } of deletions) {
						// A fresh desired chunk always wins over an older tombstone.
						if (
							database
								.prepare("SELECT 1 FROM chunks WHERE id = ?")
								.get(chunk_id)
						) {
							database
								.prepare(
									"DELETE FROM remote_tombstones WHERE collection_name = ? AND chunk_id = ?",
								)
								.run(brain.zeroEntropyCollection, chunk_id);
							continue;
						}
						try {
							await client.remove([chunk_id]);
							database
								.prepare(
									"DELETE FROM remote_tombstones WHERE collection_name = ? AND chunk_id = ?",
								)
								.run(brain.zeroEntropyCollection, chunk_id);
						} catch (error) {
							const message = "remote deletion failed";
							database
								.prepare(
									"UPDATE remote_tombstones SET attempts = attempts + 1, last_error = ?, next_retry_at = ? WHERE collection_name = ? AND chunk_id = ?",
								)
								.run(
									message,
									new Date(
										Date.now() + Math.min(10_000, brain.retryBackoffMs ?? 250),
									).toISOString(),
									brain.zeroEntropyCollection,
									chunk_id,
								);
							deferred.push(message);
						}
					}
				} catch (error) {
					const message = "remote reconciliation failed";
					deferred.push(message);
					database
						.prepare(
							"UPDATE remote_chunk_checkpoints SET status = 'failed', last_error = ?, attempts = attempts + 1 WHERE collection_name = ? AND status IN ('pending', 'failed')",
						)
						.run(message, brain.zeroEntropyCollection);
				}
			outstanding = Number(
				(
					database
						.prepare(
							"SELECT COUNT(*) AS count FROM remote_chunk_checkpoints WHERE collection_name = ? AND status <> 'indexed'",
						)
						.get(brain.zeroEntropyCollection) as { count: number }
				).count,
			);
			remoteStatus = deferred.length
				? "degraded"
				: outstanding
					? "pending"
					: "complete";
			}
			database
				.prepare(
					"UPDATE index_runs SET finished_at = ?, status = ?, documents_indexed = ?, chunks_indexed = ?, documents_scanned = ?, remote_pending = ?, local_status = ?, remote_status = ?, summary = ? WHERE id = ?",
				)
				.run(
					new Date().toISOString(),
					localStatus === "complete" && (remoteStatus === "complete" || remoteStatus === "disabled") ? "complete" : "degraded",
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
