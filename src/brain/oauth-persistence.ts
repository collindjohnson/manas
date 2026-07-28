import { createHash, randomBytes } from "node:crypto";
import type { OAuthClient, OAuthScope, AuthorizationRequest, OAuthTokenResponse } from "./oauth";

type Store = { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]>; transaction<T>(action: (store: Store) => Promise<T>): Promise<T>; };
type ClientRow = { id: string; tenant_id: string; public_client: boolean; redirect_uris: unknown; scopes: unknown; client_secret_hash: string | null; revoked_at: string | Date | null };
const scopeRank: Record<OAuthScope, number> = { read: 1, write: 2, admin: 3 };
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function token(): string { return randomBytes(32).toString("base64url"); }
function scopes(value: unknown): OAuthScope[] { const result = typeof value === "string" ? JSON.parse(value) : value; if (!Array.isArray(result) || !result.length || result.some((scope) => typeof scope !== "string" || !Object.hasOwn(scopeRank, scope))) throw new Error("invalid OAuth scope"); return [...new Set(result)] as OAuthScope[]; }
function subset(requested: OAuthScope[], allowed: OAuthScope[]): boolean { return requested.every((scope) => allowed.includes(scope)); }
function pkce(verifier: string, challenge: string): boolean { return createHash("sha256").update(verifier).digest("base64url") === challenge; }

export class DurableOAuthAuthorizationServer {
	constructor(private readonly store: Store, private readonly clock: () => Date = () => new Date(), private readonly lifetimes = { codeMs: 60_000, accessMs: 15 * 60_000, refreshMs: 30 * 24 * 60 * 60_000 }) {}

	async registerClient(client: OAuthClient & { tenantId?: string }): Promise<void> {
		if (!client.id.trim() || !client.redirectUris.length || client.redirectUris.some((uri) => !uri.trim() || uri.includes("#"))) throw new Error("invalid OAuth client");
		const allowedScopes = scopes(client.allowedScopes);
		const tenantId = client.tenantId ?? "local";
		const existing = await this.store.query<ClientRow>("SELECT id, tenant_id, public_client, redirect_uris, scopes, client_secret_hash, revoked_at FROM brain_oauth_clients WHERE id = $1", [client.id]);
		if (existing[0]) {
			const row = existing[0];
			const redirectUris = typeof row.redirect_uris === "string" ? JSON.parse(row.redirect_uris) : row.redirect_uris;
			const configuredScopes = scopes(row.scopes);
			if (row.tenant_id === tenantId && row.public_client === !client.confidential && JSON.stringify(redirectUris) === JSON.stringify(client.redirectUris) && JSON.stringify(configuredScopes) === JSON.stringify(allowedScopes) && row.client_secret_hash === (client.secretHash ?? null) && !row.revoked_at) return;
			throw new Error("OAuth client configuration conflicts with the registered client");
		}
		await this.store.query("INSERT INTO brain_oauth_clients (id, tenant_id, name, public_client, redirect_uris, scopes, client_secret_hash) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)", [client.id, tenantId, client.id, !client.confidential, JSON.stringify(client.redirectUris), JSON.stringify(allowedScopes), client.secretHash ?? null]);
	}

	private async client(id: string): Promise<ClientRow> { const rows = await this.store.query<ClientRow>("SELECT id, tenant_id, public_client, redirect_uris, scopes, client_secret_hash, revoked_at FROM brain_oauth_clients WHERE id = $1", [id]); const row = rows[0]; if (!row || row.revoked_at) throw new Error("OAuth client is not registered"); return row; }
	async isRegisteredRedirect(clientId: string, redirectUri: string): Promise<boolean> { try { const row = await this.client(clientId); const uris = typeof row.redirect_uris === "string" ? JSON.parse(row.redirect_uris) : row.redirect_uris; return Array.isArray(uris) && uris.includes(redirectUri); } catch { return false; } }

	async authorize(request: AuthorizationRequest): Promise<{ code: string; redirectUri: string; state?: string }> {
		const client = await this.client(request.clientId); const redirects = typeof client.redirect_uris === "string" ? JSON.parse(client.redirect_uris) : client.redirect_uris; const allowed = scopes(client.scopes);
		if (!Array.isArray(redirects) || !redirects.includes(request.redirectUri)) throw new Error("OAuth redirect URI is not registered");
		if (request.codeChallengeMethod !== "S256" || request.codeChallenge.length < 43 || !request.subject.trim() || !request.tenantId.trim() || !subset(request.scope, allowed)) throw new Error("invalid OAuth authorization request");
		const code = token(); await this.store.query("INSERT INTO brain_oauth_authorization_codes (code_hash, client_id, tenant_id, subject, redirect_uri, code_challenge, scopes, brain_ids, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)", [hash(code), request.clientId, request.tenantId, request.subject, request.redirectUri, request.codeChallenge, JSON.stringify(request.scope), JSON.stringify(request.brainIds ?? []), new Date(this.clock().getTime() + this.lifetimes.codeMs).toISOString()]);
		return { code, redirectUri: request.redirectUri, ...(request.state === undefined ? {} : { state: request.state }) };
	}

	async redeemCode(input: { clientId: string; code: string; redirectUri: string; codeVerifier: string; clientSecret?: string }): Promise<OAuthTokenResponse> {
		const client = await this.client(input.clientId); const rows = await this.store.query<{ code_hash: string; tenant_id: string; subject: string; redirect_uri: string; code_challenge: string; scopes: unknown; brain_ids: unknown; expires_at: string | Date; redeemed_at: string | Date | null }>("SELECT code_hash, tenant_id, subject, redirect_uri, code_challenge, scopes, brain_ids, expires_at, redeemed_at FROM brain_oauth_authorization_codes WHERE code_hash = $1 AND client_id = $2", [hash(input.code), input.clientId]); const code = rows[0];
		if (!code || code.redeemed_at || new Date(code.expires_at) <= this.clock() || code.redirect_uri !== input.redirectUri || client.client_secret_hash && hash(input.clientSecret ?? "") !== client.client_secret_hash || !pkce(input.codeVerifier, code.code_challenge)) throw new Error("invalid or expired authorization code");
		const redeemed = await this.store.query<{ code_hash: string }>("UPDATE brain_oauth_authorization_codes SET redeemed_at = $2 WHERE code_hash = $1 AND redeemed_at IS NULL RETURNING code_hash", [code.code_hash, this.clock().toISOString()]);
		if (!redeemed.length) throw new Error("invalid or expired authorization code");
		return this.issueTokens(code.subject, code.tenant_id, scopes(code.scopes), Array.isArray(code.brain_ids) ? code.brain_ids as string[] : typeof code.brain_ids === "string" ? JSON.parse(code.brain_ids) as string[] : []);
	}

	private async issueTokens(subject: string, tenantId: string, scope: OAuthScope[], brainIds: string[]): Promise<OAuthTokenResponse> {
		const accessToken = token(); const refreshToken = token(); const now = this.clock();
		await this.store.transaction(async (transaction) => { await transaction.query("INSERT INTO brain_oauth_tokens (token_hash, token_kind, subject, tenant_id, brain_ids, scopes, expires_at) VALUES ($1, 'access', $2, $3, $4::jsonb, $5::jsonb, $6), ($7, 'refresh', $2, $3, $4::jsonb, $5::jsonb, $8)", [hash(accessToken), subject, tenantId, JSON.stringify(brainIds), JSON.stringify(scope), new Date(now.getTime() + this.lifetimes.accessMs).toISOString(), hash(refreshToken), new Date(now.getTime() + this.lifetimes.refreshMs).toISOString()]); });
		return { tokenType: "Bearer", accessToken, expiresIn: this.lifetimes.accessMs / 1_000, scope: [...scope], refreshToken };
	}

	async refresh(refreshToken: string, requestedScope?: OAuthScope[]): Promise<OAuthTokenResponse> {
		const rows = await this.store.query<{ token_hash: string; subject: string; tenant_id: string; brain_ids: unknown; scopes: unknown; expires_at: string | Date; revoked_at: string | Date | null }>("SELECT token_hash, subject, tenant_id, brain_ids, scopes, expires_at, revoked_at FROM brain_oauth_tokens WHERE token_hash = $1 AND token_kind = 'refresh'", [hash(refreshToken)]); const old = rows[0];
		if (!old || old.revoked_at || new Date(old.expires_at) <= this.clock()) { if (old?.revoked_at) await this.store.query("UPDATE brain_oauth_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE subject = $1 AND tenant_id = $3", [old.subject, this.clock().toISOString(), old.tenant_id]); throw new Error("invalid refresh token"); }
		const current = scopes(old.scopes); const requested = requestedScope ?? current; if (!subset(requested, current)) throw new Error("refresh scope cannot be widened"); const brains = typeof old.brain_ids === "string" ? JSON.parse(old.brain_ids) as string[] : old.brain_ids as string[];
		const claimed = await this.store.query<{ token_hash: string }>("UPDATE brain_oauth_tokens SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL RETURNING token_hash", [old.token_hash, this.clock().toISOString()]);
		if (!claimed.length) throw new Error("invalid refresh token");
		const next = await this.issueTokens(old.subject, old.tenant_id, requested, brains); await this.store.query("UPDATE brain_oauth_tokens SET replaced_by = $2 WHERE token_hash = $1", [old.token_hash, hash(next.refreshToken)]); return next;
	}

	async revoke(value: string): Promise<void> { await this.store.query("UPDATE brain_oauth_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE token_hash = $1", [hash(value), this.clock().toISOString()]); }
	async introspect(value: string): Promise<{ active: boolean; subject?: string; tenantId?: string; brainIds?: string[]; scope?: OAuthScope[] }> { const rows = await this.store.query<{ subject: string; tenant_id: string; brain_ids: unknown; scopes: unknown; expires_at: string | Date; revoked_at: string | Date | null }>("SELECT subject, tenant_id, brain_ids, scopes, expires_at, revoked_at FROM brain_oauth_tokens WHERE token_hash = $1 AND token_kind = 'access'", [hash(value)]); const row = rows[0]; if (!row || row.revoked_at || new Date(row.expires_at) <= this.clock()) return { active: false }; return { active: true, subject: row.subject, tenantId: row.tenant_id, brainIds: typeof row.brain_ids === "string" ? JSON.parse(row.brain_ids) : row.brain_ids as string[], scope: scopes(row.scopes) }; }
}
