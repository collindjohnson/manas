import { createHash } from "node:crypto";
import { assertSchemaPack, planSchemaUpgrade, type SchemaPack, type SchemaUpgradePlan } from "./schema";

export interface SchemaPage { id: string; path: string; content: string; }
export interface SchemaUpgradeRepository {
	head(): Promise<string | undefined>;
	setSchemaPack(pack: { id: string; version: string }, expectedHead?: string): Promise<{ settings: unknown; commit: string }>;
}
export interface SchemaUpgradeExecutionPlan extends SchemaUpgradePlan { id: string; expectedHead?: string; pageHashes: Array<{ id: string; path: string; contentHash: string }>; status: "planned" | "approved" | "applied" | "rolled_back"; }

function hashPages(pages: SchemaPage[]): Array<{ id: string; path: string; contentHash: string }> { return pages.map((page) => ({ id: page.id, path: page.path, contentHash: createHash("sha256").update(page.content).digest("hex") })).sort((left, right) => left.id.localeCompare(right.id)); }

export class SchemaUpgradeCoordinator {
	private readonly plans = new Map<string, SchemaUpgradeExecutionPlan>();
	constructor(private readonly repository: SchemaUpgradeRepository) {}

	plan(from: SchemaPack, to: SchemaPack, pages: SchemaPage[]): SchemaUpgradeExecutionPlan {
		const current = assertSchemaPack(from); const next = assertSchemaPack(to); const computed = planSchemaUpgrade(current, next); const id = createHash("sha256").update(JSON.stringify({ from: current, to: next, pages: hashPages(pages) })).digest("hex").slice(0, 32);
		const plan: SchemaUpgradeExecutionPlan = { ...computed, id, expectedHead: undefined, pageHashes: hashPages(pages), status: "planned" }; this.plans.set(id, plan); return { ...plan, pageHashes: [...plan.pageHashes] };
	}

	approve(id: string, expectedHead?: string): SchemaUpgradeExecutionPlan { const plan = this.require(id); if (plan.status !== "planned") throw new Error("schema upgrade plan is not pending"); plan.status = "approved"; plan.expectedHead = expectedHead; return { ...plan, pageHashes: [...plan.pageHashes] }; }

	async apply(id: string, input: { to: SchemaPack; pages: SchemaPage[]; migrate?: (page: SchemaPage, target: SchemaPack) => Promise<SchemaPage> }): Promise<{ plan: SchemaUpgradeExecutionPlan; commit: string; rollback: { pack: { id: string; version: string }; expectedHead: string } }> {
		const plan = this.require(id); if (plan.status !== "approved") throw new Error("schema upgrade requires explicit approval"); const target = assertSchemaPack(input.to); if (plan.requiresMigration && !input.migrate) throw new Error("schema upgrade requires an approved migration callback");
		const currentHashes = hashPages(input.pages); if (JSON.stringify(currentHashes) !== JSON.stringify(plan.pageHashes)) throw new Error("schema upgrade page set is stale");
		const migrated = input.migrate ? await Promise.all(input.pages.map((page) => input.migrate!(page, target))) : input.pages;
		if (!plan.requiresMigration && JSON.stringify(hashPages(migrated)) !== JSON.stringify(plan.pageHashes)) throw new Error("compatible schema activation changed page bytes");
		const commit = await this.repository.setSchemaPack(target, plan.expectedHead); plan.status = "applied"; return { plan: { ...plan, pageHashes: [...plan.pageHashes] }, commit: commit.commit, rollback: { pack: { id: plan.from.id, version: plan.from.version }, expectedHead: commit.commit } };
	}

	async rollback(id: string, expectedHead: string): Promise<{ commit: string }> { const plan = this.require(id); if (plan.status !== "applied") throw new Error("schema upgrade is not applied"); const result = await this.repository.setSchemaPack(plan.from, expectedHead); plan.status = "rolled_back"; return { commit: result.commit }; }
	get(id: string): SchemaUpgradeExecutionPlan { const plan = this.require(id); return { ...plan, pageHashes: [...plan.pageHashes] }; }
	private require(id: string): SchemaUpgradeExecutionPlan { const plan = this.plans.get(id); if (!plan) throw new Error("schema upgrade plan was not found"); return plan; }
}

export function schemaContext(pack: SchemaPack): { id: string; version: string; fingerprint: string } { const normalized = assertSchemaPack(pack); return { id: normalized.id, version: normalized.version, fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") }; }
