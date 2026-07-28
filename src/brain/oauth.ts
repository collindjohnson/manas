import { createHash, randomBytes, randomUUID } from "node:crypto";

export type OAuthScope = "read" | "write" | "admin";
export interface OAuthClient {
	id: string;
	redirectUris: string[];
	allowedScopes: OAuthScope[];
	confidential: boolean;
	secretHash?: string;
}

export interface AuthorizationRequest {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	codeChallengeMethod: "S256";
	scope: OAuthScope[];
	subject: string;
	tenantId: string;
	brainIds?: string[];
	state?: string;
	nonce?: string;
}

export interface OAuthTokenResponse {
	tokenType: "Bearer";
	accessToken: string;
	expiresIn: number;
	scope: OAuthScope[];
	refreshToken: string;
}

type AuthorizationRecord = AuthorizationRequest & { codeHash: string; expiresAt: number; redeemed: boolean };
type RefreshRecord = { tokenHash: string; subject: string; tenantId: string; brainIds: string[]; scope: OAuthScope[]; expiresAt: number; revoked: boolean; replacedBy?: string };
type AccessRecord = { tokenHash: string; subject: string; tenantId: string; brainIds: string[]; scope: OAuthScope[]; expiresAt: number; revoked: boolean };

const scopeRank: Record<OAuthScope, number> = { read: 1, write: 2, admin: 3 };
const codeLifetimeMs = 60_000;
const accessLifetimeMs = 15 * 60_000;
const refreshLifetimeMs = 30 * 24 * 60 * 60_000;

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function token(): string {
	return randomBytes(32).toString("base64url");
}

function assertScope(scope: OAuthScope[]): void {
	if (!scope.length || new Set(scope).size !== scope.length || scope.some((value) => !Object.hasOwn(scopeRank, value))) throw new Error("invalid OAuth scope");
}

function isSubset(scope: OAuthScope[], allowed: OAuthScope[]): boolean {
	return scope.every((value) => allowed.includes(value));
}

function validPkce(verifier: string, challenge: string): boolean {
	return hash(verifier).length > 0 && createHash("sha256").update(verifier).digest("base64url") === challenge;
}

export class OAuthAuthorizationServer {
	private readonly clients = new Map<string, OAuthClient>();
	private readonly authorizationCodes = new Map<string, AuthorizationRecord>();
	private readonly refreshTokens = new Map<string, RefreshRecord>();
	private readonly accessTokens = new Map<string, AccessRecord>();

	registerClient(client: OAuthClient): void {
		if (!client.id.trim() || !client.redirectUris.length || client.redirectUris.some((uri) => !uri.trim() || uri.includes("#"))) throw new Error("invalid OAuth client");
		assertScope(client.allowedScopes);
		if (this.clients.has(client.id)) throw new Error("OAuth client already exists");
		this.clients.set(client.id, { ...client, redirectUris: [...client.redirectUris], allowedScopes: [...client.allowedScopes] });
	}

	isRegisteredRedirect(clientId: string, redirectUri: string): boolean {
		return this.clients.get(clientId)?.redirectUris.includes(redirectUri) === true;
	}

	authorize(request: AuthorizationRequest): { code: string; redirectUri: string; state?: string } {
		const client = this.clients.get(request.clientId);
		if (!client || !client.redirectUris.includes(request.redirectUri)) throw new Error("OAuth redirect URI is not registered");
		if (request.codeChallengeMethod !== "S256" || request.codeChallenge.length < 43) throw new Error("S256 PKCE is required");
		if (!request.subject.trim() || !request.tenantId.trim()) throw new Error("invalid OAuth subject");
		assertScope(request.scope);
		if (!isSubset(request.scope, client.allowedScopes)) throw new Error("OAuth scope is not allowed");
		const code = token();
		this.authorizationCodes.set(hash(code), { ...request, codeHash: hash(code), expiresAt: Date.now() + codeLifetimeMs, redeemed: false });
		return { code, redirectUri: request.redirectUri, ...(request.state === undefined ? {} : { state: request.state }) };
	}

	redeemCode(input: { clientId: string; code: string; redirectUri: string; codeVerifier: string; clientSecret?: string }): OAuthTokenResponse {
		const record = this.authorizationCodes.get(hash(input.code));
		const client = this.clients.get(input.clientId);
		if (!record || !client || record.redeemed || record.expiresAt <= Date.now() || record.clientId !== input.clientId || record.redirectUri !== input.redirectUri) throw new Error("invalid or expired authorization code");
		if (client.confidential && (!client.secretHash || !input.clientSecret || hash(input.clientSecret) !== client.secretHash)) throw new Error("OAuth client authentication failed");
		if (!validPkce(input.codeVerifier, record.codeChallenge)) throw new Error("PKCE verification failed");
		record.redeemed = true;
		return this.issueTokens(record.subject, record.tenantId, record.brainIds ?? [], record.scope);
	}

	refresh(refreshToken: string, requestedScope?: OAuthScope[]): OAuthTokenResponse {
		const old = this.refreshTokens.get(hash(refreshToken));
		if (!old || old.revoked || old.expiresAt <= Date.now()) throw new Error("invalid refresh token");
		if (requestedScope !== undefined) {
			assertScope(requestedScope);
			if (!isSubset(requestedScope, old.scope)) throw new Error("refresh scope cannot be widened");
		}
		old.revoked = true;
		const result = this.issueTokens(old.subject, old.tenantId, old.brainIds, requestedScope ?? old.scope);
		old.replacedBy = hash(result.refreshToken);
		return result;
	}

	revoke(tokenValue: string): void {
		const tokenHash = hash(tokenValue);
		const access = this.accessTokens.get(tokenHash);
		if (access) access.revoked = true;
		const refresh = this.refreshTokens.get(tokenHash);
		if (refresh) refresh.revoked = true;
	}

	introspect(accessToken: string): { active: boolean; subject?: string; tenantId?: string; brainIds?: string[]; scope?: OAuthScope[] } {
		const record = this.accessTokens.get(hash(accessToken));
		if (!record || record.revoked || record.expiresAt <= Date.now()) return { active: false };
		return { active: true, subject: record.subject, tenantId: record.tenantId, brainIds: [...record.brainIds], scope: [...record.scope] };
	}

	private issueTokens(subject: string, tenantId: string, brainIds: string[], scope: OAuthScope[]): OAuthTokenResponse {
		const accessToken = token();
		const refreshToken = token();
		this.accessTokens.set(hash(accessToken), { tokenHash: hash(accessToken), subject, tenantId, brainIds: [...brainIds], scope: [...scope], expiresAt: Date.now() + accessLifetimeMs, revoked: false });
		this.refreshTokens.set(hash(refreshToken), { tokenHash: hash(refreshToken), subject, tenantId, brainIds: [...brainIds], scope: [...scope], expiresAt: Date.now() + refreshLifetimeMs, revoked: false });
		return { tokenType: "Bearer", accessToken, expiresIn: accessLifetimeMs / 1_000, scope: [...scope], refreshToken };
	}
}

export interface WebSession {
	id: string;
	subject: string;
	tenantId: string;
	csrfToken: string;
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
}

export class SessionManager {
	private readonly sessions = new Map<string, WebSession>();
	constructor(private readonly options: { idleMs?: number; absoluteMs?: number } = {}) {}

	create(subject: string, tenantId: string, now = Date.now()): WebSession {
		if (!subject.trim() || !tenantId.trim()) throw new Error("invalid session subject");
		const current = new Date(now).toISOString();
		const session = { id: token(), subject, tenantId, csrfToken: token(), createdAt: current, lastSeenAt: current, expiresAt: new Date(now + (this.options.absoluteMs ?? 8 * 60 * 60_000)).toISOString() };
		this.sessions.set(hash(session.id), session);
		return { ...session };
	}

	rotate(id: string, subject: string, tenantId: string, now = Date.now()): WebSession {
		this.destroy(id);
		return this.create(subject, tenantId, now);
	}

	validate(id: string, csrfToken: string, now = Date.now()): WebSession {
		const session = this.sessions.get(hash(id));
		if (!session || session.expiresAt <= new Date(now).toISOString() || new Date(now - new Date(session.lastSeenAt).getTime()).getTime() > (this.options.idleMs ?? 30 * 60_000) || session.csrfToken !== csrfToken) throw new Error("invalid or expired session");
		session.lastSeenAt = new Date(now).toISOString();
		return { ...session };
	}

	destroy(id: string): void {
		this.sessions.delete(hash(id));
	}
}

export function serializeSessionCookie(sessionId: string, options: { secure?: boolean; maxAgeSeconds?: number } = {}): string {
	if (!sessionId.trim() || /[;\r\n]/.test(sessionId)) throw new Error("invalid session cookie");
	const maxAge = options.maxAgeSeconds ?? 8 * 60 * 60;
	if (!Number.isInteger(maxAge) || maxAge < 1) throw new Error("invalid session cookie lifetime");
	return `${options.secure === false ? "brain_session" : "__Host-brain_session"}=${encodeURIComponent(sessionId)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${options.secure === false ? "" : "; Secure"}`;
}

export function readSessionCookie(header: string | null): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === "__Host-brain_session" || name === "brain_session") return decodeURIComponent(rest.join("="));
	}
	return undefined;
}

export function validateSessionRequest(manager: SessionManager, request: Request, options: { csrfToken: string; stateChanging?: boolean; allowedOrigins?: string[] }): WebSession {
	const origin = request.headers.get("origin");
	if (origin !== null && !(options.allowedOrigins ?? []).includes(origin)) throw new Error("session origin is not allowed");
	if (options.stateChanging && request.method !== "GET" && request.method !== "HEAD" && request.headers.get("x-csrf-token") !== options.csrfToken) throw new Error("CSRF token is invalid");
	const id = readSessionCookie(request.headers.get("cookie"));
	if (!id) throw new Error("session cookie is missing");
	return manager.validate(id, options.csrfToken);
}

export class QuotaLedger {
	private readonly usage = new Map<string, { used: number; resetAt: number }>();
	consume(principal: string, dimension: string, amount: number, limit: number, windowMs: number, now = Date.now()): { used: number; remaining: number; resetAt: number } {
		if (!principal.trim() || !dimension.trim() || !Number.isFinite(amount) || amount < 0 || !Number.isFinite(limit) || limit < 0 || !Number.isInteger(windowMs) || windowMs < 1) throw new Error("invalid quota");
		const key = hash(principal + "\0" + dimension);
		const current = this.usage.get(key);
		const value = !current || current.resetAt <= now ? { used: 0, resetAt: now + windowMs } : current;
		if (value.used + amount > limit) throw new Error("quota exceeded");
		value.used += amount;
		this.usage.set(key, value);
		return { used: value.used, remaining: Math.max(0, limit - value.used), resetAt: value.resetAt };
	}
}
