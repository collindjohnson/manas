export type MembershipRole = "member" | "admin" | "owner";
export type TenantScope = "read" | "write" | "admin";

export interface TenantRecord { id: string; name: string; }
export interface BrainRecord { id: string; tenantId: string; name: string; canonicalRemote?: string; }
export interface Membership { userId: string; tenantId: string; brainId?: string; role: MembershipRole; visibilityLabels: string[]; }

const roleScope: Record<MembershipRole, TenantScope> = { member: "read", admin: "write", owner: "admin" };

function permitted(role: MembershipRole, required: TenantScope): boolean {
	return roleScope[role] === "admin" || roleScope[role] === "write" && required !== "admin" || roleScope[role] === "read" && required === "read";
}

export class TenantDirectory {
	private readonly tenants = new Map<string, TenantRecord>();
	private readonly brains = new Map<string, BrainRecord>();
	private readonly memberships: Membership[] = [];

	addTenant(tenant: TenantRecord): void {
		if (!tenant.id.trim() || !tenant.name.trim() || this.tenants.has(tenant.id)) throw new Error("invalid or duplicate tenant");
		this.tenants.set(tenant.id, { ...tenant });
	}

	addBrain(brain: BrainRecord): void {
		if (!brain.id.trim() || !brain.name.trim() || !this.tenants.has(brain.tenantId) || this.brains.has(brain.id)) throw new Error("invalid or duplicate brain");
		this.brains.set(brain.id, { ...brain });
	}

	grant(membership: Membership): void {
		if (!membership.userId.trim() || !membership.tenantId.trim() || !this.tenants.has(membership.tenantId) || membership.brainId && (!this.brains.has(membership.brainId) || this.brains.get(membership.brainId)!.tenantId !== membership.tenantId) || !membership.visibilityLabels.every((label) => label.trim())) throw new Error("invalid membership");
		if (this.memberships.some((value) => value.userId === membership.userId && value.tenantId === membership.tenantId && value.brainId === membership.brainId)) throw new Error("membership already exists");
		this.memberships.push({ ...membership, visibilityLabels: [...membership.visibilityLabels] });
	}

	authorize(userId: string, tenantId: string, brainId: string | undefined, required: TenantScope, labels: string[] = []): void {
		const brain = brainId ? this.brains.get(brainId) : undefined;
		if (!this.tenants.has(tenantId) || brainId && (!brain || brain.tenantId !== tenantId)) throw new Error("scope is not available");
		const membership = this.memberships.find((value) => value.userId === userId && value.tenantId === tenantId && (value.brainId === brainId || value.brainId === undefined));
		if (!membership || !permitted(membership.role, required) || labels.some((label) => membership.visibilityLabels.length > 0 && !membership.visibilityLabels.includes(label))) throw new Error("scope is not authorized");
	}

	filterVisible<T extends { tenantId: string; brainId: string; accessLabels?: string[] }>(userId: string, rows: T[], required: TenantScope): T[] {
		return rows.filter((row) => {
			try { this.authorize(userId, row.tenantId, row.brainId, required, row.accessLabels ?? []); return true; } catch { return false; }
		});
	}

	listBrains(userId: string, tenantId: string): BrainRecord[] {
		return [...this.brains.values()].filter((brain) => brain.tenantId === tenantId && this.memberships.some((membership) => membership.userId === userId && membership.tenantId === tenantId && (membership.brainId === brain.id || membership.brainId === undefined)));
	}
}

type SqlStore = { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]> };

function labelsFromRow(value: unknown): string[] {
	const parsed = typeof value === "string" ? JSON.parse(value) : value;
	if (!Array.isArray(parsed) || parsed.some((label) => typeof label !== "string")) throw new Error("invalid visibility labels");
	return parsed;
}

export class SqlTenantDirectory {
	constructor(private readonly store: SqlStore) {}

	private async membership(userId: string, tenantId: string, brainId?: string): Promise<{ role: MembershipRole; visibilityLabels: string[] }> {
		if (!userId.trim() || !tenantId.trim() || brainId !== undefined && !brainId.trim()) throw new Error("scope is not available");
		const rows = await this.store.query<{ role: MembershipRole; visibility_labels: unknown }>(
			"SELECT membership.role, membership.visibility_labels FROM brain_memberships tenant_membership JOIN LATERAL (SELECT bm.role, bm.visibility_labels, true AS specific FROM brain_members bm WHERE bm.user_id = tenant_membership.user_id AND bm.tenant_id = tenant_membership.tenant_id AND bm.brain_id = $3 UNION ALL SELECT tenant_membership.role, tenant_membership.visibility_labels, false AS specific) membership ON true WHERE tenant_membership.user_id = $1 AND tenant_membership.tenant_id = $2 AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM brain_registry b WHERE b.id = $3 AND b.tenant_id = $2)) ORDER BY membership.specific DESC LIMIT 1",
			[userId, tenantId, brainId ?? null],
		);
		const row = rows[0];
		if (!row) throw new Error("scope is not authorized");
		return { role: row.role, visibilityLabels: labelsFromRow(row.visibility_labels) };
	}

	private async grantedLabels(userId: string, tenantId: string, brainId: string): Promise<string[]> {
		const rows = await this.store.query<{ label: string }>(
			"SELECT label FROM brain_visibility_grants grant_record WHERE grant_record.tenant_id = $1 AND grant_record.brain_id = $2 AND ((grant_record.subject_type = 'tenant' AND grant_record.subject_id = $1) OR (grant_record.subject_type = 'user' AND grant_record.subject_id = $3) OR (grant_record.subject_type = 'group' AND EXISTS (SELECT 1 FROM brain_group_members gm WHERE gm.group_id = grant_record.subject_id AND gm.user_id = $3)))",
			[tenantId, brainId, userId],
		);
		return rows.map((row) => row.label).filter((label) => typeof label === "string" && label.trim());
	}

	async addUser(id: string): Promise<void> {
		if (!id.trim()) throw new Error("invalid user");
		await this.store.query("INSERT INTO brain_users (id) VALUES ($1)", [id]);
	}

	async addTenant(tenant: TenantRecord): Promise<void> {
		if (!tenant.id.trim() || !tenant.name.trim()) throw new Error("invalid tenant");
		await this.store.query("INSERT INTO brain_tenants (id, name) VALUES ($1, $2)", [tenant.id, tenant.name]);
	}

	async addBrain(brain: BrainRecord): Promise<void> {
		if (!brain.id.trim() || !brain.name.trim() || !brain.tenantId.trim()) throw new Error("invalid brain");
		await this.store.query("INSERT INTO brain_registry (id, tenant_id, name, canonical_remote) VALUES ($1, $2, $3, $4)", [brain.id, brain.tenantId, brain.name, brain.canonicalRemote ?? null]);
	}

	async grant(membership: Membership): Promise<void> {
		if (!membership.userId.trim() || !membership.tenantId.trim() || membership.brainId !== undefined && !membership.brainId.trim() || !membership.visibilityLabels.every((label) => label.trim())) throw new Error("invalid membership");
		if (membership.brainId) await this.store.query("INSERT INTO brain_members (user_id, tenant_id, brain_id, role, visibility_labels) VALUES ($1, $2, $3, $4, $5::jsonb)", [membership.userId, membership.tenantId, membership.brainId, membership.role, JSON.stringify(membership.visibilityLabels)]);
		else await this.store.query("INSERT INTO brain_memberships (user_id, tenant_id, role, visibility_labels) VALUES ($1, $2, $3, $4::jsonb)", [membership.userId, membership.tenantId, membership.role, JSON.stringify(membership.visibilityLabels)]);
	}

	async authorize(userId: string, tenantId: string, brainId: string | undefined, required: TenantScope, labels: string[] = []): Promise<void> {
		const authorization = await this.authorizeWithLabels(userId, tenantId, brainId, required);
		const allowed = authorization.allowedAccessLabels;
		if (allowed && labels.some((label) => !allowed.includes(label))) throw new Error("scope is not authorized");
	}

	async authorizeWithLabels(userId: string, tenantId: string, brainId: string | undefined, required: TenantScope): Promise<{ allowedAccessLabels?: string[] }> {
		const row = await this.membership(userId, tenantId, brainId);
		if (!permitted(row.role, required)) throw new Error("scope is not authorized");
		if (!row.visibilityLabels.length) return {};
		if (!brainId) return { allowedAccessLabels: [...new Set(row.visibilityLabels)].sort() };
		return { allowedAccessLabels: [...new Set([...row.visibilityLabels, ...await this.grantedLabels(userId, tenantId, brainId)])].sort() };
	}

	async listBrains(userId: string, tenantId: string): Promise<BrainRecord[]> {
		const rows = await this.store.query<{ id: string; tenant_id: string; name: string; canonical_remote: string | null }>(
			"SELECT DISTINCT b.id, b.tenant_id, b.name, b.canonical_remote FROM brain_registry b JOIN brain_memberships tm ON tm.tenant_id = b.tenant_id AND tm.user_id = $1 LEFT JOIN brain_members bm ON bm.brain_id = b.id AND bm.user_id = $1 WHERE b.tenant_id = $2 AND (bm.brain_id IS NOT NULL OR tm.user_id IS NOT NULL) ORDER BY b.id",
			[userId, tenantId],
		);
		return rows.map((row) => ({ id: row.id, tenantId: row.tenant_id, name: row.name, ...(row.canonical_remote ? { canonicalRemote: row.canonical_remote } : {}) }));
	}
}
