type Repository = {
	head(): Promise<string | undefined>;
	verify(ref?: string): Promise<{ valid: boolean; issues: string[]; commit: string }>;
	snapshot(ref?: string): Promise<{ brainId: string }>;
	getSettings(): Promise<{ schemaPack: { id: string; version: string }; sources: Record<string, unknown> }>;
	listPages(includeDeleted?: boolean): Promise<Array<{ deleted?: boolean }>>;
};
type Store = { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]> };
const sourceHealthModule = await import([".", "source-health"].join(String.fromCharCode(47)));

export async function diagnoseBrain(repository: Repository, store?: Store): Promise<{ ok: boolean; repository: { head?: string; valid: boolean; issues: string[]; pages: { active: number; deleted: number }; schemaPack: { id: string; version: string }; sources: number }; projection?: { latestCommit?: string; status?: string; current: boolean; jobs: Record<string, number>; sources: unknown[] }; warnings: string[] }> {
	const head = await repository.head();
	const [settings, pages] = await Promise.all([repository.getSettings(), repository.listPages(true)]);
	if (!head) return { ok: false, repository: { head, valid: false, issues: ["repository has no committed snapshot"], pages: { active: pages.filter((page) => !page.deleted).length, deleted: pages.filter((page) => page.deleted).length }, schemaPack: settings.schemaPack, sources: Object.keys(settings.sources).length }, warnings: ["repository has no committed snapshot"] };
	const [verification, snapshot] = await Promise.all([repository.verify(), repository.snapshot()]);
	const warnings = [...verification.issues];
	const result = { ok: verification.valid, repository: { head, valid: verification.valid, issues: verification.issues, pages: { active: pages.filter((page) => !page.deleted).length, deleted: pages.filter((page) => page.deleted).length }, schemaPack: settings.schemaPack, sources: Object.keys(settings.sources).length }, warnings } as { ok: boolean; repository: { head?: string; valid: boolean; issues: string[]; pages: { active: number; deleted: number }; schemaPack: { id: string; version: string }; sources: number }; projection?: { latestCommit?: string; status?: string; current: boolean; jobs: Record<string, number>; sources: unknown[] }; warnings: string[] };
	if (!store) return result;
	const [runs, jobs, sources] = await Promise.all([
		store.query<{ git_commit: string; status: string }>("SELECT git_commit, status FROM brain_projection_runs WHERE brain_id = $1 ORDER BY started_at DESC LIMIT 1", [snapshot.brainId]),
		store.query<{ status: string; count: string }>("SELECT status, COUNT(*)::text AS count FROM brain_jobs GROUP BY status"),
		sourceHealthModule.sourceHealth(store, snapshot.brainId),
	]);
	const latest = runs[0];
	const current = latest?.git_commit === head && latest.status === "complete";
	if (!current) warnings.push("projection is stale or incomplete; run brain index or a queued index job");
	result.projection = { latestCommit: latest?.git_commit, status: latest?.status, current, jobs: Object.fromEntries(jobs.map((job) => [job.status, Number(job.count)])), sources };
	result.ok = result.ok && current;
	return result;
}
