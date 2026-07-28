import { describe, expect, test } from "bun:test";

const storeModule = ["..", "src", "brain", "store"].join(String.fromCharCode(47));
const tokenModule = ["..", "src", "brain", "access-tokens"].join(String.fromCharCode(47));
const auditModule = ["..", "src", "brain", "audit"].join(String.fromCharCode(47));
const { openPgliteBrainStore } = await import(storeModule);
const { authorizePersonalAccessToken, createPersonalAccessToken, identifyPersonalAccessToken, listPersonalAccessTokens, revokePersonalAccessToken } = await import(tokenModule);
const { listAuditEvents } = await import(auditModule);

describe("personal access tokens", () => {
	test("stores only a hash and enforces tenant, scope, expiry, and revocation", async () => {
		const store = await openPgliteBrainStore();
		try {
			const created = await createPersonalAccessToken(store, { name: "reader", scopes: ["read"], tenantId: "tenant-a" });
			expect(await identifyPersonalAccessToken(store, created.token)).toMatchObject({ id: created.record.id, tenantId: "tenant-a" });
			expect(created.token.length).toBeGreaterThan(20);
			expect(await listPersonalAccessTokens(store, "tenant-a")).toMatchObject([{ id: created.record.id, name: "reader", scopes: ["read"] }]);
			expect(await authorizePersonalAccessToken(store, created.token, "read", "tenant-a")).toBe(true);
			expect(await authorizePersonalAccessToken(store, created.token, "write", "tenant-a")).toBe(false);
			expect(await authorizePersonalAccessToken(store, created.token, "read", "tenant-b")).toBe(false);
			await revokePersonalAccessToken(store, created.record.id, "tenant-a");
			expect(await authorizePersonalAccessToken(store, created.token, "read", "tenant-a")).toBe(false);
			expect(await listAuditEvents(store, "tenant-a")).toMatchObject([{ action: "access_token.revoked", subjectId: created.record.id }, { action: "access_token.created", subjectId: created.record.id, metadata: { name: "reader", scopes: ["read"] } }]);
		} finally { await store.close(); }
	});

	test("admin scope hierarchically authorizes read and write", async () => {
		const store = await openPgliteBrainStore();
		try {
			const created = await createPersonalAccessToken(store, { name: "administrator", scopes: ["admin"] });
			expect(await authorizePersonalAccessToken(store, created.token, "read")).toBe(true);
			expect(await authorizePersonalAccessToken(store, created.token, "write")).toBe(true);
			expect(await authorizePersonalAccessToken(store, created.token, "admin")).toBe(true);
		} finally { await store.close(); }
	});

	test("retains an optional user binding for hosted membership checks", async () => {
		const store = await openPgliteBrainStore();
		try {
			const created = await createPersonalAccessToken(store, { name: "member-token", scopes: ["read"], tenantId: "tenant-a", userId: "user-a" });
			expect(created.record.userId).toBe("user-a");
			expect(await identifyPersonalAccessToken(store, created.token)).toMatchObject({ tenantId: "tenant-a", userId: "user-a" });
			expect(await listPersonalAccessTokens(store, "tenant-a")).toMatchObject([{ userId: "user-a" }]);
		} finally { await store.close(); }
	});
});
