export const RLS_TENANT_TABLES = [
	"brain_documents",
	"brain_projection_runs",
	"brain_jobs",
	"brain_job_schedules",
	"brain_access_tokens",
	"brain_audit_events",
	"brain_links",
	"brain_active_projection_runs",
	"brain_document_revisions",
	"brain_model_descriptors",
	"brain_ingestion_runs",
	"brain_job_events",
	"brain_job_attachments",
	"brain_registry",
	"brain_memberships",
	"brain_members",
	"brain_groups",
	"brain_visibility_grants",
	"brain_source_registrations",
	"brain_oauth_clients",
	"brain_web_sessions",
	"brain_oauth_authorization_codes",
	"brain_oauth_tokens",
	"brain_quota_usage",
	"brain_agent_runs",
	"brain_rollback_receipts",
	"brain_schema_upgrade_plans",
	"brain_migration_drills",
	"brain_projection_documents",
	"brain_projection_links",
	"brain_repository_snapshots",
	"brain_graph_nodes",
	"brain_graph_edges",
	"brain_facts",
	"brain_claims",
	"brain_timelines",
	"brain_source_failures",
	"brain_embedding_coverage",
	"brain_cache_entries",
	"brain_chunk_embeddings",
	"brain_skill_feedback",
	"brain_admin_action_receipts",
	"brain_scheduler_leases",
] as const;

const RLS_BRAIN_SCOPED_TABLES = new Set<string>([
	"brain_documents",
	"brain_projection_runs",
	"brain_model_descriptors",
	"brain_ingestion_runs",
	"brain_links",
	"brain_active_projection_runs",
	"brain_document_revisions",
	"brain_source_failures",
	"brain_embedding_coverage",
	"brain_cache_entries",
	"brain_quota_usage",
	"brain_agent_runs",
	"brain_rollback_receipts",
	"brain_schema_upgrade_plans",
	"brain_migration_drills",
	"brain_projection_documents",
	"brain_projection_links",
	"brain_repository_snapshots",
	"brain_visibility_grants",
	"brain_source_registrations",
	"brain_graph_nodes",
	"brain_graph_edges",
	"brain_facts",
	"brain_claims",
	"brain_timelines",
	"brain_chunk_embeddings",
	"brain_skill_feedback",
]);

function tenantPredicate(table: string): string {
	const tenant = "tenant_id = current_setting('app.tenant_id', true)";
	if (table === "brain_registry") return `${tenant} AND (NULLIF(current_setting('app.user_id', true), '') IS NULL OR EXISTS (SELECT 1 FROM brain_memberships m WHERE m.user_id = current_setting('app.user_id', true) AND m.tenant_id = brain_registry.tenant_id) OR EXISTS (SELECT 1 FROM brain_members m WHERE m.user_id = current_setting('app.user_id', true) AND m.tenant_id = brain_registry.tenant_id AND m.brain_id = brain_registry.id))`;
	if (!RLS_BRAIN_SCOPED_TABLES.has(table)) return tenant;
	return `${tenant} AND (NULLIF(current_setting('app.user_id', true), '') IS NULL OR EXISTS (SELECT 1 FROM brain_memberships m WHERE m.user_id = current_setting('app.user_id', true) AND m.tenant_id = ${table}.tenant_id) OR EXISTS (SELECT 1 FROM brain_members m WHERE m.user_id = current_setting('app.user_id', true) AND m.tenant_id = ${table}.tenant_id AND m.brain_id = ${table}.brain_id))`;
}

function scopedMembershipPredicate(tenantExpression: string, brainExpression: string): string {
	return `(NULLIF(current_setting('app.user_id', true), '') IS NULL OR EXISTS (SELECT 1 FROM brain_memberships m WHERE m.user_id = current_setting('app.user_id', true) AND m.tenant_id = ${tenantExpression}) OR EXISTS (SELECT 1 FROM brain_members m WHERE m.user_id = current_setting('app.user_id', true) AND m.tenant_id = ${tenantExpression} AND m.brain_id = ${brainExpression}))`;
}

export function postgresRlsStatements(): string[] {
	const direct = RLS_TENANT_TABLES.flatMap((table) => [
		"ALTER TABLE " + table + " ENABLE ROW LEVEL SECURITY",
		"ALTER TABLE " + table + " FORCE ROW LEVEL SECURITY",
		"DROP POLICY IF EXISTS brain_tenant_isolation ON " + table,
		"CREATE POLICY brain_tenant_isolation ON " + table + " USING (" + tenantPredicate(table) + ") WITH CHECK (" + tenantPredicate(table) + ")",
	]);
	return [
		...direct,
		"ALTER TABLE brain_chunks ENABLE ROW LEVEL SECURITY",
		"ALTER TABLE brain_chunks FORCE ROW LEVEL SECURITY",
		"DROP POLICY IF EXISTS brain_chunk_tenant_isolation ON brain_chunks",
		"CREATE POLICY brain_chunk_tenant_isolation ON brain_chunks USING (EXISTS (SELECT 1 FROM brain_documents d WHERE d.id = brain_chunks.document_id AND d.tenant_id = current_setting('app.tenant_id', true) AND " + scopedMembershipPredicate("d.tenant_id", "d.brain_id") + ")) WITH CHECK (EXISTS (SELECT 1 FROM brain_documents d WHERE d.id = brain_chunks.document_id AND d.tenant_id = current_setting('app.tenant_id', true) AND " + scopedMembershipPredicate("d.tenant_id", "d.brain_id") + "))",
		"ALTER TABLE brain_projection_chunks ENABLE ROW LEVEL SECURITY",
		"ALTER TABLE brain_projection_chunks FORCE ROW LEVEL SECURITY",
		"DROP POLICY IF EXISTS brain_projection_chunk_tenant_isolation ON brain_projection_chunks",
		"CREATE POLICY brain_projection_chunk_tenant_isolation ON brain_projection_chunks USING (EXISTS (SELECT 1 FROM brain_projection_documents d WHERE d.run_id = brain_projection_chunks.run_id AND d.document_id = brain_projection_chunks.document_id AND d.tenant_id = current_setting('app.tenant_id', true) AND " + scopedMembershipPredicate("d.tenant_id", "d.brain_id") + ")) WITH CHECK (EXISTS (SELECT 1 FROM brain_projection_documents d WHERE d.run_id = brain_projection_chunks.run_id AND d.document_id = brain_projection_chunks.document_id AND d.tenant_id = current_setting('app.tenant_id', true) AND " + scopedMembershipPredicate("d.tenant_id", "d.brain_id") + "))",
		"ALTER TABLE brain_group_members ENABLE ROW LEVEL SECURITY",
		"ALTER TABLE brain_group_members FORCE ROW LEVEL SECURITY",
		"DROP POLICY IF EXISTS brain_group_member_tenant_isolation ON brain_group_members",
		"CREATE POLICY brain_group_member_tenant_isolation ON brain_group_members USING (EXISTS (SELECT 1 FROM brain_groups g WHERE g.id = brain_group_members.group_id AND g.tenant_id = current_setting('app.tenant_id', true) AND (NULLIF(current_setting('app.user_id', true), '') IS NULL OR EXISTS (SELECT 1 FROM brain_memberships m WHERE m.user_id = current_setting('app.user_id', true) AND m.tenant_id = g.tenant_id)))) WITH CHECK (EXISTS (SELECT 1 FROM brain_groups g WHERE g.id = brain_group_members.group_id AND g.tenant_id = current_setting('app.tenant_id', true) AND (NULLIF(current_setting('app.user_id', true), '') IS NULL OR EXISTS (SELECT 1 FROM brain_memberships m WHERE m.user_id = current_setting('app.user_id', true) AND m.tenant_id = g.tenant_id))))",
	];
}

export async function setPostgresTenantContext(store: { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]> }, tenantId: string, userId?: string): Promise<void> {
	if (!tenantId.trim() || tenantId.includes("\0")) throw new Error("invalid PostgreSQL tenant context");
	await store.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
	if (userId !== undefined) {
		if (!userId.trim() || userId.includes("\0")) throw new Error("invalid PostgreSQL user context");
		await store.query("SELECT set_config('app.user_id', $1, true)", [userId]);
	}
}

export async function enablePostgresRls(store: { exec(sql: string): Promise<void> }): Promise<void> {
	for (const statement of postgresRlsStatements()) await store.exec(statement);
}
