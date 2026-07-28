import { randomUUID } from "node:crypto";

import type { SqlValue } from "./store";

type Store = { query<T extends Record<string, unknown>>(sql: string, parameters?: SqlValue[]): Promise<T[]> };

export type SkillFeedbackOutcome = "used" | "volunteered" | "rejected";

export interface DurableSkillFeedback {
	id: string;
	tenantId: string;
	brainId: string;
	skillId: string;
	version: string;
	agent: string;
	outcome: SkillFeedbackOutcome;
	confidence?: number;
	recordedAt: string;
}

type FeedbackRow = {
	id: string;
	tenant_id: string;
	brain_id: string;
	skill_id: string;
	skill_version: string;
	agent: string;
	outcome: SkillFeedbackOutcome;
	confidence: number | string | null;
	recorded_at: string | Date;
};

function toFeedback(row: FeedbackRow): DurableSkillFeedback {
	if (!["used", "volunteered", "rejected"].includes(row.outcome)) throw new Error("invalid stored skill feedback outcome");
	return {
		id: row.id,
		tenantId: row.tenant_id,
		brainId: row.brain_id,
		skillId: row.skill_id,
		version: row.skill_version,
		agent: row.agent,
		outcome: row.outcome,
		...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
		recordedAt: new Date(row.recorded_at).toISOString(),
	};
}

function validateFeedback(input: { tenantId?: string; brainId?: string; skillId: string; version?: string; agent: string; outcome: SkillFeedbackOutcome; confidence?: number }): { tenantId: string; brainId: string; version: string } {
	const tenantId = input.tenantId ?? "local";
	const brainId = input.brainId ?? "local";
	const version = input.version ?? "unknown";
	if (!tenantId.trim() || !brainId.trim() || !input.skillId.trim() || !version.trim() || !["claude-code", "codex", "cursor", "openclaw", "hermes", "mcp"].includes(input.agent) || !["used", "volunteered", "rejected"].includes(input.outcome)) throw new Error("invalid skill feedback");
	if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) throw new Error("invalid skill feedback confidence");
	return { tenantId, brainId, version };
}

export async function recordSkillFeedback(store: Store, input: { id?: string; tenantId?: string; brainId?: string; skillId: string; version?: string; agent: string; outcome: SkillFeedbackOutcome; confidence?: number; recordedAt?: Date }): Promise<DurableSkillFeedback> {
	const scope = validateFeedback(input);
	const id = input.id ?? randomUUID();
	if (!id.trim()) throw new Error("invalid skill feedback id");
	const recordedAt = (input.recordedAt ?? new Date()).toISOString();
	const rows = await store.query<FeedbackRow>("INSERT INTO brain_skill_feedback (id, tenant_id, brain_id, skill_id, skill_version, agent, outcome, confidence, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING RETURNING id, tenant_id, brain_id, skill_id, skill_version, agent, outcome, confidence, recorded_at", [id, scope.tenantId, scope.brainId, input.skillId, scope.version, input.agent, input.outcome, input.confidence ?? null, recordedAt]);
	if (rows[0]) return toFeedback(rows[0]);
	const existing = await store.query<FeedbackRow>("SELECT id, tenant_id, brain_id, skill_id, skill_version, agent, outcome, confidence, recorded_at FROM brain_skill_feedback WHERE id = $1 AND tenant_id = $2 AND brain_id = $3", [id, scope.tenantId, scope.brainId]);
	if (!existing[0]) throw new Error("skill feedback id is already used");
	return toFeedback(existing[0]);
}

export async function listSkillFeedback(store: Store, options: { tenantId?: string; brainId?: string; skillId?: string; limit?: number } = {}): Promise<DurableSkillFeedback[]> {
	const tenantId = options.tenantId ?? "local";
	const brainId = options.brainId ?? "local";
	const limit = options.limit ?? 100;
	if (!tenantId.trim() || !brainId.trim() || !Number.isInteger(limit) || limit < 1 || limit > 1_000 || options.skillId !== undefined && !options.skillId.trim()) throw new Error("invalid skill feedback listing");
	const rows = await store.query<FeedbackRow>("SELECT id, tenant_id, brain_id, skill_id, skill_version, agent, outcome, confidence, recorded_at FROM brain_skill_feedback WHERE tenant_id = $1 AND brain_id = $2 AND ($3::text IS NULL OR skill_id = $3) ORDER BY recorded_at DESC, id DESC LIMIT $4", [tenantId, brainId, options.skillId ?? null, limit]);
	return rows.map(toFeedback);
}
