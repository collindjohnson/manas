import * as embeddingModule from "./local-embeddings";
type Store = {
	query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]>;
	exec(sql: string): Promise<void>;
	transaction<T>(action: (store: Store) => Promise<T>): Promise<T>;
};

import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./providers";

export interface EmbeddingReplacementOptions {
	batchSize?: number;
	tenantId?: string;
	brainId?: string;
	rollbackWindowMs?: number;
	now?: Date;
}

export interface EmbeddingActivationReceipt {
	active: ActiveEmbeddingModel;
	previous?: ActiveEmbeddingModel;
	totalChunks: number;
	coveredChunks: number;
	rollbackUntil: string;
}

export interface ActiveEmbeddingModel {
	id: string;
	dimensions: number;
	provider?: string;
	revision?: string;
	normalized?: boolean;
	templateVersion?: string;
	privacy?: "local" | "hosted";
	fingerprint?: string;
}

export function embeddingFingerprint(model: ActiveEmbeddingModel): string {
	if (!model.id || !Number.isInteger(model.dimensions) || model.dimensions < 1) throw new Error("invalid embedding model");
	return createHash("sha256").update(JSON.stringify({ provider: model.provider ?? "unknown", model: model.id, revision: model.revision ?? "", dimensions: model.dimensions, normalized: model.normalized ?? true, templateVersion: model.templateVersion ?? "1", privacy: model.privacy ?? "local" })).digest("hex");
}

export async function activeEmbeddingModel(store: Store): Promise<ActiveEmbeddingModel | undefined> {
	const rows = await store.query<{ value: ActiveEmbeddingModel }>("SELECT value FROM brain_operational_state WHERE key = 'active_embedding_model'");
	const model = rows[0]?.value;
	return model && typeof model.id === "string" && Number.isInteger(model.dimensions) && model.dimensions > 0 ? { ...model, fingerprint: model.fingerprint ?? embeddingFingerprint(model) } : undefined;
}

export async function setActiveEmbeddingModel(store: Store, model: ActiveEmbeddingModel): Promise<{ changed: boolean; reembeddingRequired: boolean }> {
	const normalized = { ...model, fingerprint: embeddingFingerprint(model) };
	return store.transaction(async (transaction) => {
		const previous = await activeEmbeddingModel(transaction);
		const changed = previous?.fingerprint !== normalized.fingerprint;
		if (!changed) return { changed: false, reembeddingRequired: false };
		await transaction.query(
			"INSERT INTO brain_operational_state (key, value) VALUES ('active_embedding_model', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
			[JSON.stringify(normalized)],
		);
		// Keep the previous model's vectors available during replacement build and
		// rollback. The embedding job selects rows by embedding_model and writes a
		// second model's vectors without destroying the active index.
		return { changed: true, reembeddingRequired: true };
	});
}

/**
 * Builds a model-specific vector set beside the current set and only changes
 * the active pointer after every scoped chunk has coverage. A failed build
 * leaves the old pointer and vectors untouched.
 */
export async function buildAndActivateEmbeddingModel(store: Store, provider: EmbeddingProvider, options: EmbeddingReplacementOptions = {}): Promise<EmbeddingActivationReceipt> {
	const tenantId = options.tenantId ?? "local";
	const brainId = options.brainId ?? "local";
	const batchSize = options.batchSize ?? 32;
	const rollbackWindowMs = options.rollbackWindowMs ?? 24 * 60 * 60_000;
	const now = options.now ?? new Date();
	if (!tenantId.trim() || !brainId.trim() || !Number.isInteger(batchSize) || batchSize < 1 || !Number.isInteger(rollbackWindowMs) || rollbackWindowMs < 0) throw new Error("invalid embedding replacement options");
	const previous = await activeEmbeddingModel(store);
	const target: ActiveEmbeddingModel = {
		id: provider.model.id,
		dimensions: provider.model.dimensions,
		fingerprint: provider.model.fingerprint ?? provider.model.id,
	};
	const fingerprint = target.fingerprint!;
	const totalRows = await store.query<{ count: number | string }>("SELECT COUNT(*) AS count FROM brain_chunks c JOIN brain_documents d ON d.id = c.document_id WHERE d.tenant_id = $1 AND d.brain_id = $2 AND d.deleted_at IS NULL", [tenantId, brainId]);
	const totalChunks = Number(totalRows[0]?.count ?? 0);
	await embeddingModule.indexLocalEmbeddings(store, provider, batchSize, { tenantId, brainId });
	const coveredRows = await store.query<{ count: number | string }>("SELECT COUNT(*) AS count FROM brain_chunk_embeddings e JOIN brain_chunks c ON c.id = e.chunk_id JOIN brain_documents d ON d.id = c.document_id WHERE e.tenant_id = $1 AND e.brain_id = $2 AND e.model_fingerprint = $3 AND d.deleted_at IS NULL", [tenantId, brainId, fingerprint]);
	const coveredChunks = Number(coveredRows[0]?.count ?? 0);
	if (coveredChunks !== totalChunks) throw new Error("embedding replacement coverage is incomplete");
	const rollbackUntil = new Date(now.getTime() + rollbackWindowMs).toISOString();
	await store.transaction(async (transaction) => {
		await transaction.query("INSERT INTO brain_operational_state (key, value) VALUES ('active_embedding_model', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [JSON.stringify(target)]);
		await transaction.query("INSERT INTO brain_operational_state (key, value) VALUES ('embedding_replacement', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [JSON.stringify({ previous: previous ?? null, active: target, rollbackUntil })]);
	});
	return { active: target, ...(previous ? { previous } : {}), totalChunks, coveredChunks, rollbackUntil };
}

export async function rollbackEmbeddingModel(store: Store, now = new Date()): Promise<ActiveEmbeddingModel> {
	const rows = await store.query<{ value: unknown }>("SELECT value FROM brain_operational_state WHERE key = 'embedding_replacement'");
	const value = typeof rows[0]?.value === "string" ? JSON.parse(rows[0].value) as Record<string, unknown> : rows[0]?.value as Record<string, unknown> | undefined;
	if (!value || typeof value.rollbackUntil !== "string" || value.rollbackUntil <= now.toISOString()) throw new Error("embedding rollback window is unavailable");
	const previous = value.previous as ActiveEmbeddingModel | null;
	if (!previous) throw new Error("previous embedding model is unavailable");
	await store.transaction(async (transaction) => {
		await transaction.query("UPDATE brain_operational_state SET value = $1::jsonb, updated_at = now() WHERE key = 'active_embedding_model'", [JSON.stringify(previous)]);
		await transaction.query("DELETE FROM brain_operational_state WHERE key = 'embedding_replacement'");
	});
	return previous;
}
