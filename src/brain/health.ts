import { access } from "node:fs/promises";
import { configuredArchiveEmbeddingProvider, countArchiveEmbeddings } from "@manas-brain-archive-embeddings";
import type { Config } from "../config";
import { scanArchive } from "../archive";
import { assertBrainIntegrity, openBrainDatabase } from "./database";
import {
	createZeroEntropyClient,
	resolveZeroEntropyCredential,
} from "./zeroentropy";

export interface BrainHealth {
	ok: boolean;
	archiveDocuments: number;
	indexedDocuments: number;
	indexedChunks: number;
	synchronizedChunks: number;
	uploadedChunks: number;
	failedChunks: number;
	tombstones: number;
	semantic: "ready" | "degraded";
	credential: "environment" | "keychain" | "local" | "missing";
	checkpoints: {
		pending: number;
		uploaded: number;
		indexed: number;
		failed: number;
	};
	warnings: string[];
	readiness: { lexical: "ready" | "degraded"; semantic: "ready" | "degraded"; reranking: "configured" | "not_configured"; synthesis: "configured" | "not_configured" };
	diagnostics?: {
		archive: { documents: number; warnings: number };
		database: { available: boolean; integrity: "ok" | "failed" };
		checkpoints: {
			collection: string;
			pending: number;
			uploaded: number;
			indexed: number;
			failed: number;
			tombstones: number;
		};
		run?: { status: string; localStatus?: string; remoteStatus?: string };
		zeroEntropy: "ready" | "degraded" | "not-checked";
	};
}
export async function brainHealth(config: Config): Promise<BrainHealth> {
	const brain = config.brain;
	if (!brain) throw new Error("brain configuration is unavailable");
	const localEmbeddingProvider = configuredArchiveEmbeddingProvider(config);
	const scan = await scanArchive(config.archiveRoot);
	const warnings = [...scan.warnings];
	try {
		await access(brain.databasePath);
	} catch {
		return {
			ok: false,
			archiveDocuments: scan.documents.length,
			indexedDocuments: 0,
			indexedChunks: 0,
			synchronizedChunks: 0,
			uploadedChunks: 0,
			failedChunks: 0,
			tombstones: 0,
			semantic: "degraded",
			credential: localEmbeddingProvider ? "local" : "missing",
			checkpoints: { pending: 0, uploaded: 0, indexed: 0, failed: 0 },
			warnings: [...warnings, "index database has not been created; run index"],
			readiness: { lexical: "degraded", semantic: "degraded", reranking: brain.rerankerEndpoint && brain.rerankerModel ? "configured" : "not_configured", synthesis: brain.generationEndpoint && brain.generationModel ? "configured" : "not_configured" },
			diagnostics: {
				archive: {
					documents: scan.documents.length,
					warnings: scan.warnings.length,
				},
				database: { available: false, integrity: "failed" },
				checkpoints: {
					collection: brain.zeroEntropyCollection,
					pending: 0,
					uploaded: 0,
					indexed: 0,
					failed: 0,
					tombstones: 0,
				},
				zeroEntropy: "not-checked",
			},
		};
	}
	const database = await openBrainDatabase(brain.databasePath);
	try {
		const count = (sql: string) =>
			Number((database.prepare(sql).get() as { count: number }).count);
		assertBrainIntegrity(database);
		const indexedDocuments = count("SELECT COUNT(*) AS count FROM documents");
		const indexedChunks = count("SELECT COUNT(*) AS count FROM chunks");
		const pendingChunks = count(
			"SELECT COUNT(*) AS count FROM remote_chunk_checkpoints WHERE collection_name = '" +
				brain.zeroEntropyCollection.replaceAll("'", "''") +
				"' AND status = 'pending'",
		);
		const synchronizedChunks = count(
			"SELECT COUNT(*) AS count FROM remote_chunk_checkpoints WHERE collection_name = '" +
				brain.zeroEntropyCollection.replaceAll("'", "''") +
				"' AND status = 'indexed'",
		);
		const uploadedChunks = count(
			"SELECT COUNT(*) AS count FROM remote_chunk_checkpoints WHERE collection_name = '" +
				brain.zeroEntropyCollection.replaceAll("'", "''") +
				"' AND status = 'uploaded'",
		);
		const failedChunks = count(
			"SELECT COUNT(*) AS count FROM remote_chunk_checkpoints WHERE collection_name = '" +
				brain.zeroEntropyCollection.replaceAll("'", "''") +
				"' AND status = 'failed'",
		);
		const tombstones = count(
			"SELECT COUNT(*) AS count FROM remote_tombstones WHERE collection_name = '" +
				brain.zeroEntropyCollection.replaceAll("'", "''") +
				"'",
		);
		if (indexedDocuments !== scan.documents.length)
			warnings.push("index is stale; run index");
		const credential = localEmbeddingProvider
			? { value: "local", source: "local" as const }
			: await resolveZeroEntropyCredential(
					brain.keychainService,
					brain.keychainAccount,
				);
		if (localEmbeddingProvider) {
			if (countArchiveEmbeddings(database, localEmbeddingProvider) < indexedChunks)
				warnings.push("semantic index is stale; run index");
			} else if (!credential.value)
			warnings.push("semantic search is unavailable: ZeroEntropy credential is not configured");
		else if (synchronizedChunks !== indexedChunks)
			warnings.push(uploadedChunks ? "semantic indexing is pending remote completion" : "semantic index is stale; run index");
		if (!localEmbeddingProvider && failedChunks) warnings.push("semantic synchronization has failed work");
		if (!localEmbeddingProvider && tombstones) warnings.push("semantic deletions are pending");
		let zeroEntropy: "ready" | "degraded" | "not-checked" = "not-checked";
		if (credential.value && !localEmbeddingProvider) {
			try {
				await createZeroEntropyClient({
					baseUrl: brain.zeroEntropyBaseUrl,
					collection: brain.zeroEntropyCollection,
					apiKey: credential.value,
					timeoutMs: brain.requestTimeoutMs,
					retryAttempts: 1,
				}).status?.();
				zeroEntropy = "ready";
			} catch {
				zeroEntropy = "degraded";
				warnings.push("ZeroEntropy live health check failed");
			}
		}
		const optionalSemanticWarnings = !localEmbeddingProvider && !credential.value
			? new Set([
					"semantic search is unavailable: ZeroEntropy credential is not configured",
					"semantic deletions are pending",
				])
			: new Set<string>();
		const coreWarnings = warnings.filter((warning) => !optionalSemanticWarnings.has(warning));
		const latestRun = database
			.prepare(
				"SELECT status, local_status, remote_status FROM index_runs ORDER BY id DESC LIMIT 1",
			)
			.get() as {
			status: string;
			local_status?: string;
			remote_status?: string;
		} | null;
		return {
			ok: coreWarnings.length === 0,
			archiveDocuments: scan.documents.length,
			indexedDocuments,
			indexedChunks,
			synchronizedChunks,
			uploadedChunks,
			failedChunks,
			tombstones,
			semantic: warnings.some((warning) => warning.includes("semantic"))
				? "degraded"
				: "ready",
			credential: credential.source,
			checkpoints: {
				pending: pendingChunks,
				uploaded: uploadedChunks,
				indexed: synchronizedChunks,
				failed: failedChunks,
			},
			warnings,
			readiness: { lexical: indexedDocuments ? "ready" : "degraded", semantic: warnings.some((warning) => warning.includes("semantic")) ? "degraded" : "ready", reranking: brain.rerankerEndpoint && brain.rerankerModel ? "configured" : "not_configured", synthesis: brain.generationEndpoint && brain.generationModel ? "configured" : "not_configured" },
			diagnostics: {
				archive: {
					documents: scan.documents.length,
					warnings: scan.warnings.length,
				},
				database: { available: true, integrity: "ok" },
				checkpoints: {
					collection: brain.zeroEntropyCollection,
					pending: pendingChunks,
					uploaded: uploadedChunks,
					indexed: synchronizedChunks,
					failed: failedChunks,
					tombstones,
				},
				...(latestRun
					? {
							run: {
								status: latestRun.status,
								localStatus: latestRun.local_status,
								remoteStatus: latestRun.remote_status,
							},
						}
					: {}),
				zeroEntropy,
			},
		};
	} finally {
		database.close();
	}
}
