import { describe, expect, test } from "bun:test";
import { openPgliteBrainStore } from "../src/brain/store";
import { authorizePersonalAccessToken, createPersonalAccessToken } from "../src/brain/access-tokens";
import { runAuthorizationFuzz, runIncidentDrill } from "../src/security-drills";

describe("security drills", () => {
	test("authorization fuzzing denies tampering, scope escalation, and tenant crossing", async () => {
		const store = await openPgliteBrainStore();
		try {
			const issued = await createPersonalAccessToken(store, { name: "drill", tenantId: "tenant-a", scopes: ["read"] });
			const result = await runAuthorizationFuzz((token, scope, tenantId) => authorizePersonalAccessToken(store, token, scope, tenantId), { token: issued.token, scope: "read", tenantId: "tenant-a", expected: true });
			expect(result.violations).toEqual([]);
			expect(result.denied).toBeGreaterThan(0);
		} finally { await store.close(); }
	});

	test("incident drill records ordered containment and recovery evidence", async () => {
		const steps: string[] = [];
		const result = await runIncidentDrill({
			revokeCredentials: async () => { steps.push("revoke"); },
			isolateTenant: async () => { steps.push("isolate"); },
			restoreFromVerifiedBackup: async () => { steps.push("restore"); },
			recordEvidence: async (step) => { steps.push(`evidence:${step}`); },
		}, new Date("2026-01-01T00:00:00.000Z"));
		expect(result.recovered).toBe(true);
		expect(result.steps).toEqual(["revoke-credentials", "isolate-tenant", "restore-verified-backup"]);
		expect(steps).toEqual(["revoke", "evidence:revoke-credentials", "isolate", "evidence:isolate-tenant", "restore", "evidence:restore-verified-backup"]);
	});
});
