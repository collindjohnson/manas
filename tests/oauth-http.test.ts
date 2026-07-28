import { describe, expect, test } from "bun:test";
import { OAuthAuthorizationServer } from "../src/brain/oauth";
import { OAuthHttpService } from "../src/brain/oauth-http";

async function verifier(): Promise<{ value: string; challenge: string }> {
	const value = "0123456789012345678901234567890123456789012345678901234567890123";
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	const bytes = new Uint8Array(digest);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return { value, challenge: btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") };
}

function form(body: Record<string, string>): RequestInit {
	return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) };
}

describe("OAuth HTTP protocol boundary", () => {
	test("authorizes through exact redirect and redeems a single-use code", async () => {
		const oauth = new OAuthAuthorizationServer();
		oauth.registerClient({ id: "client", redirectUris: ["https://app.example/callback"], allowedScopes: ["read", "write"], confidential: false });
		const service = new OAuthHttpService({ server: oauth, resolveAuthorizationSubject: () => ({ subject: "user-1", tenantId: "tenant-1", brainIds: ["brain-1"] }) });
		const pkce = await verifier();
		const authorize = await service.handle(new Request(`https://auth.example/oauth/authorize?response_type=code&client_id=client&redirect_uri=${encodeURIComponent("https://app.example/callback")}&code_challenge=${pkce.challenge}&code_challenge_method=S256&scope=read%20write&state=state-1`));
		expect(authorize.status).toBe(302);
		const location = new URL(authorize.headers.get("location") as string);
		expect(location.origin + location.pathname).toBe("https://app.example/callback");
		expect(location.searchParams.get("state")).toBe("state-1");
		const token = await service.handle(new Request("https://auth.example/oauth/token", form({ grant_type: "authorization_code", client_id: "client", code: location.searchParams.get("code") as string, redirect_uri: "https://app.example/callback", code_verifier: pkce.value })));
		expect(token.status).toBe(200);
		const payload = await token.json() as { access_token: string; refresh_token: string; scope: string };
		expect(payload.scope).toBe("read write");
		const replay = await service.handle(new Request("https://auth.example/oauth/token", form({ grant_type: "authorization_code", client_id: "client", code: location.searchParams.get("code") as string, redirect_uri: "https://app.example/callback", code_verifier: pkce.value })));
		expect(replay.status).toBe(400);
		const introspection = await service.handle(new Request("https://auth.example/oauth/introspect", form({ token: payload.access_token })));
		expect(await introspection.json()).toMatchObject({ active: true, sub: "user-1", tenant_id: "tenant-1", scope: "read write" });
	});

	test("rejects PKCE downgrade and unregistered redirects", async () => {
		const oauth = new OAuthAuthorizationServer();
		oauth.registerClient({ id: "client", redirectUris: ["https://app.example/callback"], allowedScopes: ["read"], confidential: false });
		const service = new OAuthHttpService({ server: oauth, resolveAuthorizationSubject: () => ({ subject: "user-1", tenantId: "tenant-1" }) });
		const pkce = await verifier();
		const downgrade = await service.handle(new Request("https://auth.example/oauth/authorize?response_type=code&client_id=client&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&code_challenge=plain-value&code_challenge_method=plain&scope=read"));
		expect(downgrade.status).toBe(302);
		expect(new URL(downgrade.headers.get("location") as string).searchParams.get("error")).toBe("invalid_request");
		const openRedirect = await service.handle(new Request(`https://auth.example/oauth/authorize?response_type=code&client_id=client&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback&code_challenge=${pkce.challenge}&code_challenge_method=S256&scope=read`));
		expect(openRedirect.status).toBe(400);
	});
});
