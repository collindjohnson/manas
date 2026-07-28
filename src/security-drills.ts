import { createHash, randomBytes } from "node:crypto";

export interface AuthorizationFuzzCase { token: string; scope: "read" | "write" | "admin"; tenantId: string; expected: boolean; }
export interface AuthorizationFuzzResult { cases: number; denied: number; allowed: number; violations: string[]; }

export async function runAuthorizationFuzz(authorize: (token: string, scope: AuthorizationFuzzCase["scope"], tenantId: string) => Promise<boolean>, valid: AuthorizationFuzzCase, additional: AuthorizationFuzzCase[] = []): Promise<AuthorizationFuzzResult> {
	if (!valid.token.trim() || !valid.tenantId.trim()) throw new Error("valid authorization case is required");
	const cases: AuthorizationFuzzCase[] = [
		valid,
		{ token: "", scope: "read", tenantId: valid.tenantId, expected: false },
		{ token: valid.token + "-tampered", scope: "read", tenantId: valid.tenantId, expected: false },
		{ token: valid.token, scope: "admin", tenantId: valid.tenantId, expected: false },
		{ token: valid.token, scope: valid.scope, tenantId: valid.tenantId + "-other", expected: false },
		{ token: randomBytes(32).toString("base64url"), scope: "write", tenantId: valid.tenantId, expected: false },
		...additional,
	];
	const violations: string[] = [];
	let denied = 0;
	let allowed = 0;
	for (const [index, item] of cases.entries()) {
		const actual = await authorize(item.token, item.scope, item.tenantId);
		if (actual) allowed += 1; else denied += 1;
		if (actual !== item.expected) violations.push(`case ${index} expected ${item.expected ? "allow" : "deny"}`);
	}
	return { cases: cases.length, denied, allowed, violations };
}

export interface IncidentDrillActions { revokeCredentials(): Promise<void>; isolateTenant(): Promise<void>; restoreFromVerifiedBackup(): Promise<void>; recordEvidence(step: string, metadata: Record<string, unknown>): Promise<void>; }
export interface IncidentDrillResult { id: string; steps: string[]; evidenceHash: string; recovered: boolean; }

export async function runIncidentDrill(actions: IncidentDrillActions, now = new Date()): Promise<IncidentDrillResult> {
	const id = createHash("sha256").update(`incident:${now.toISOString()}:${randomBytes(16).toString("hex")}`).digest("hex").slice(0, 24);
	const steps: string[] = [];
	for (const [name, action] of [["revoke-credentials", actions.revokeCredentials], ["isolate-tenant", actions.isolateTenant], ["restore-verified-backup", actions.restoreFromVerifiedBackup]] as const) {
		await action();
		await actions.recordEvidence(name, { drillId: id, at: now.toISOString() });
		steps.push(name);
	}
	return { id, steps, evidenceHash: createHash("sha256").update(JSON.stringify({ id, steps })).digest("hex"), recovered: steps.includes("restore-verified-backup") };
}
