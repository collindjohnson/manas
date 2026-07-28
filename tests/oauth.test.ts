import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "oauth"].join(String.fromCharCode(47));
const { OAuthAuthorizationServer, QuotaLedger, readSessionCookie, serializeSessionCookie, SessionManager, validateSessionRequest } = await import(modulePath);

describe("OAuth, session, and quota contracts", () => {
	test("redeems S256 authorization codes once and rotates refresh tokens", async () => {
		const server = new OAuthAuthorizationServer();
		server.registerClient({ id: "client", redirectUris: ["https://app.invalid/callback"], allowedScopes: ["read", "write"], confidential: false });
		const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
		const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		const encoded = Buffer.from(challenge).toString("base64url");
		const authorization = server.authorize({ clientId: "client", redirectUri: "https://app.invalid/callback", codeChallenge: encoded, codeChallengeMethod: "S256", scope: ["read"], subject: "user", tenantId: "tenant", state: "state" });
		const tokens = server.redeemCode({ clientId: "client", code: authorization.code, redirectUri: authorization.redirectUri, codeVerifier: verifier });
		expect(server.introspect(tokens.accessToken)).toMatchObject({ active: true, subject: "user", tenantId: "tenant", scope: ["read"] });
		expect(() => server.redeemCode({ clientId: "client", code: authorization.code, redirectUri: authorization.redirectUri, codeVerifier: verifier })).toThrow("authorization code");
		const refreshed = server.refresh(tokens.refreshToken, ["read"]);
		expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);
		expect(() => server.refresh(tokens.refreshToken)).toThrow("refresh token");
		expect(() => server.refresh(refreshed.refreshToken, ["write"])).toThrow("widened");
	});

	test("requires exact redirects and PKCE, rotates secure sessions, and enforces quotas", () => {
		const server = new OAuthAuthorizationServer();
		server.registerClient({ id: "client", redirectUris: ["https://app.invalid/callback"], allowedScopes: ["read"], confidential: false });
		expect(() => server.authorize({ clientId: "client", redirectUri: "https://evil.invalid/callback", codeChallenge: "a".repeat(43), codeChallengeMethod: "S256", scope: ["read"], subject: "user", tenantId: "tenant" })).toThrow("redirect URI");
		expect(() => server.authorize({ clientId: "client", redirectUri: "https://app.invalid/callback", codeChallenge: "short", codeChallengeMethod: "S256", scope: ["read"], subject: "user", tenantId: "tenant" })).toThrow("PKCE");
		const sessions = new SessionManager({ idleMs: 100, absoluteMs: 1_000 });
		const session = sessions.create("user", "tenant", 1_000);
		expect(sessions.validate(session.id, session.csrfToken, 1_050).subject).toBe("user");
		const rotated = sessions.rotate(session.id, "user", "tenant", 1_060);
		expect(() => sessions.validate(session.id, session.csrfToken, 1_060)).toThrow("session");
		expect(sessions.validate(rotated.id, rotated.csrfToken, 1_060).tenantId).toBe("tenant");
		const quota = new QuotaLedger();
		expect(quota.consume("user", "requests", 2, 3, 1_000, 1_000).remaining).toBe(1);
		expect(() => quota.consume("user", "requests", 2, 3, 1_000, 1_001)).toThrow("quota");
		expect(quota.consume("user", "requests", 2, 3, 1_000, 2_001).used).toBe(2);
	});

	test("uses secure session cookies and CSRF/origin checks for state changes", () => {
		const manager = new SessionManager();
		const session = manager.create("user", "tenant");
		const cookie = serializeSessionCookie(session.id);
		expect(cookie).toContain("__Host-brain_session=");
		expect(readSessionCookie(cookie)).toBe(session.id);
		const request = new Request("https://app.example/update", { method: "POST", headers: { cookie, origin: "https://app.example", "x-csrf-token": session.csrfToken } });
		expect(validateSessionRequest(manager, request, { csrfToken: session.csrfToken, stateChanging: true, allowedOrigins: ["https://app.example"] })).toMatchObject({ subject: "user" });
		expect(() => validateSessionRequest(manager, new Request("https://app.example/update", { method: "POST", headers: { cookie, origin: "https://evil.example", "x-csrf-token": session.csrfToken } }), { csrfToken: session.csrfToken, stateChanging: true, allowedOrigins: ["https://app.example"] })).toThrow("origin");
	});
});
