import { modelFingerprint, type ModelDescriptor } from "./providers";

export type ModelActivationStatus = "building" | "active" | "retired" | "rolled_back";
export interface ModelActivation {
	id: string;
	descriptor: ModelDescriptor;
	fingerprint: string;
	expectedChunks: number;
	indexedChunks: number;
	dimensions: number;
	status: ModelActivationStatus;
	createdAt: string;
	rollbackUntil?: string;
}

type ModelStore = { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]>; transaction<T>(action: (store: ModelStore) => Promise<T>): Promise<T> };

export class ModelActivationCoordinator {
	private active?: ModelActivation;
	private readonly replacements = new Map<string, ModelActivation>();
	begin(descriptor: ModelDescriptor, expectedChunks: number, dimensions: number, now = new Date()): ModelActivation {
		const fingerprint = modelFingerprint(descriptor);
		if (!Number.isInteger(expectedChunks) || expectedChunks < 0 || !Number.isInteger(dimensions) || dimensions < 1) throw new Error("invalid model activation");
		if (this.active?.fingerprint === fingerprint) return { ...this.active };
		const activation: ModelActivation = { id: fingerprint.slice(0, 16), descriptor: { ...descriptor }, fingerprint, expectedChunks, indexedChunks: 0, dimensions, status: "building", createdAt: now.toISOString() };
		this.replacements.set(fingerprint, activation);
		return { ...activation };
	}
	record(fingerprint: string, chunks: number): ModelActivation {
		const activation = this.require(fingerprint);
		if (activation.status !== "building" || !Number.isInteger(chunks) || chunks < 0) throw new Error("model replacement is not writable");
		activation.indexedChunks = Math.min(activation.expectedChunks, activation.indexedChunks + chunks);
		return { ...activation };
	}
	activate(fingerprint: string, now = new Date(), rollbackWindowMs = 24 * 60 * 60_000): ModelActivation {
		const activation = this.require(fingerprint);
		if (activation.status !== "building" || activation.indexedChunks !== activation.expectedChunks) throw new Error("model replacement coverage is incomplete");
		if (!Number.isInteger(rollbackWindowMs) || rollbackWindowMs < 0) throw new Error("invalid model rollback window");
		if (this.active) this.active.status = "retired";
		activation.status = "active";
		activation.rollbackUntil = new Date(now.getTime() + rollbackWindowMs).toISOString();
		this.active = activation;
		return { ...activation };
	}
	rollback(now = new Date()): ModelActivation {
		if (!this.active || this.active.status !== "active" || !this.active.rollbackUntil || this.active.rollbackUntil <= now.toISOString()) throw new Error("model rollback window is unavailable");
		this.active.status = "rolled_back";
		const previous = [...this.replacements.values()].filter((activation) => activation.status === "retired").sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
		if (!previous) throw new Error("previous model index is unavailable");
		previous.status = "active";
		this.active = previous;
		return { ...previous };
	}
	current(): ModelActivation | undefined { return this.active ? { ...this.active } : undefined; }
	private require(fingerprint: string): ModelActivation {
		const value = this.replacements.get(fingerprint);
		if (!value) throw new Error("model replacement is not registered");
		return value;
	}
}

export async function persistModelActivation(store: ModelStore, activation: ModelActivation, tenantId = "local", brainId = "local"): Promise<void> {
	if (!tenantId.trim() || !brainId.trim()) throw new Error("invalid model scope");
	await store.query("INSERT INTO brain_model_descriptors (id, tenant_id, brain_id, kind, fingerprint, descriptor, active) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) ON CONFLICT (tenant_id, brain_id, kind, fingerprint) DO UPDATE SET descriptor = EXCLUDED.descriptor, active = EXCLUDED.active", [activation.id, tenantId, brainId, activation.descriptor.kind, activation.fingerprint, JSON.stringify(activation), activation.status === "active"]);
}

export async function activatePersistedModel(store: ModelStore, activation: ModelActivation, tenantId = "local", brainId = "local"): Promise<void> {
	if (!tenantId.trim() || !brainId.trim()) throw new Error("invalid model scope");
	await store.transaction(async (transaction) => {
		await transaction.query("UPDATE brain_model_descriptors SET active = false WHERE tenant_id = $1 AND brain_id = $2 AND kind = $3", [tenantId, brainId, activation.descriptor.kind]);
		await transaction.query("INSERT INTO brain_model_descriptors (id, tenant_id, brain_id, kind, fingerprint, descriptor, active) VALUES ($1, $2, $3, $4, $5, $6::jsonb, true) ON CONFLICT (tenant_id, brain_id, kind, fingerprint) DO UPDATE SET descriptor = EXCLUDED.descriptor, active = true", [activation.id, tenantId, brainId, activation.descriptor.kind, activation.fingerprint, JSON.stringify(activation)]);
	});
}

export async function loadActiveModels(store: ModelStore, tenantId = "local", brainId = "local"): Promise<ModelActivation[]> {
	if (!tenantId.trim() || !brainId.trim()) throw new Error("invalid model scope");
	const rows = await store.query<{ descriptor: unknown }>("SELECT descriptor FROM brain_model_descriptors WHERE tenant_id = $1 AND brain_id = $2 AND active = true ORDER BY kind, id", [tenantId, brainId]);
	return rows.map((row) => {
		const value = typeof row.descriptor === "string" ? JSON.parse(row.descriptor) : row.descriptor;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid persisted model descriptor");
		return value as ModelActivation;
	});
}
