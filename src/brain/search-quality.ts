// Machine-generated review transcripts and injected context are secondary
// sources. Keep them available for explicit operational searches.
export const APPROVAL_LOG_TITLE = "The following is the Codex agent history whose request action you are assessing.";
export const INJECTED_CONTEXT_TITLES = ["<recommended_plugins>", "<environment_context>", "<external_codex_apps_open_page>"];
const operationalQuery = new RegExp("\\b(approvals?|authorization|permissions?|risk_level|risk assessment|recommended[ _]plugins|environment_context|external_codex_apps_open_page)\\b", "i");

export function seeksOperationalRecords(query: string): boolean {
	return operationalQuery.test(query);
}

export function archiveSourcePriority(title: string | undefined, query: string): number {
	if (seeksOperationalRecords(query)) return 1;
	return title?.toLowerCase().startsWith(APPROVAL_LOG_TITLE.toLowerCase()) || INJECTED_CONTEXT_TITLES.includes(title ?? "") ? 0 : 1;
}
