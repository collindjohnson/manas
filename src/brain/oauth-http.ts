import type { AuthorizationRequest, OAuthScope, OAuthTokenResponse } from "./oauth";

export interface OAuthServerApi {
	isRegisteredRedirect(clientId: string, redirectUri: string): boolean | Promise<boolean>;
	authorize(request: AuthorizationRequest): { code: string; redirectUri: string; state?: string } | Promise<{ code: string; redirectUri: string; state?: string }>;
	redeemCode(input: { clientId: string; code: string; redirectUri: string; codeVerifier: string; clientSecret?: string }): OAuthTokenResponse | Promise<OAuthTokenResponse>;
	refresh(refreshToken: string, requestedScope?: OAuthScope[]): OAuthTokenResponse | Promise<OAuthTokenResponse>;
	revoke(token: string): void | Promise<void>;
	introspect(token: string): { active: boolean; subject?: string; tenantId?: string; brainIds?: string[]; scope?: OAuthScope[] } | Promise<{ active: boolean; subject?: string; tenantId?: string; brainIds?: string[]; scope?: OAuthScope[] }>;
}

type AuthorizationSubject = {
	subject: string;
	tenantId: string;
	brainIds?: string[];
};

export interface OAuthHttpOptions {
	server: OAuthServerApi;
	resolveAuthorizationSubject: (request: Request) => AuthorizationSubject | Promise<AuthorizationSubject | undefined>;
	allowedOrigin?: string;
}

function json(value: unknown, init: ResponseInit = {}): Response {
	return Response.json(value, {
		...init,
		headers: {
			"cache-control": "no-store",
			pragma: "no-cache",
			...(init.headers ?? {}),
		},
	});
}

function errorResponse(status: number, error: string, description: string): Response {
	return json({ error, error_description: description }, { status });
}

function tokenPayload(result: { tokenType: string; accessToken: string; expiresIn: number; scope: OAuthScope[]; refreshToken: string }): Record<string, unknown> {
	return { token_type: result.tokenType, access_token: result.accessToken, expires_in: result.expiresIn, scope: result.scope.join(" "), refresh_token: result.refreshToken };
}

async function form(request: Request): Promise<URLSearchParams> {
	const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType !== "application/x-www-form-urlencoded") throw new Error("form body required");
	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > 32 * 1024) throw new Error("request body is too large");
	return new URLSearchParams(body);
}

function scopes(value: string | null): OAuthScope[] {
	if (!value) throw new Error("scope is required");
	const result = value.split(/\s+/).filter(Boolean) as OAuthScope[];
	if (!result.length || result.some((scope) => !["read", "write", "admin"].includes(scope))) throw new Error("invalid scope");
	return [...new Set(result)];
}

function redirectWithError(uri: string, error: string, description: string, state: string | null): Response {
	const target = new URL(uri);
	target.searchParams.set("error", error);
	target.searchParams.set("error_description", description);
	if (state !== null) target.searchParams.set("state", state);
	return Response.redirect(target, 302);
}

async function safeClientRedirect(server: OAuthServerApi, clientId: string | null, redirectUri: string | null): Promise<string | undefined> {
	if (!clientId || !redirectUri) return undefined;
	try {
		return (await server.isRegisteredRedirect(clientId, redirectUri)) ? redirectUri : undefined;
	} catch {
		return undefined;
	}
}

export class OAuthHttpService {
	private readonly server: OAuthServerApi;
	private readonly resolveAuthorizationSubject: OAuthHttpOptions["resolveAuthorizationSubject"];
	private readonly allowedOrigin?: string;

	constructor(options: OAuthHttpOptions) {
		this.server = options.server;
		this.resolveAuthorizationSubject = options.resolveAuthorizationSubject;
		this.allowedOrigin = options.allowedOrigin;
	}

	async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (this.allowedOrigin && url.origin !== this.allowedOrigin) return new Response("not found", { status: 404 });
		if (url.pathname === "/oauth/authorize") return this.authorize(request, url);
		if (url.pathname === "/oauth/token" && request.method === "POST") return this.token(request);
		if (url.pathname === "/oauth/revoke" && request.method === "POST") return this.revoke(request);
		if (url.pathname === "/oauth/introspect" && request.method === "POST") return this.introspect(request);
		return new Response("not found", { status: 404 });
	}

	private async authorize(request: Request, url: URL): Promise<Response> {
		if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
		const clientId = url.searchParams.get("client_id");
		const redirectUri = url.searchParams.get("redirect_uri");
		const state = url.searchParams.get("state");
		const safeRedirect = await safeClientRedirect(this.server, clientId, redirectUri);
		try {
			if (url.searchParams.get("response_type") !== "code") throw new Error("response_type=code is required");
			if (!clientId || !redirectUri || !safeRedirect) throw new Error("redirect URI is not registered");
			const subject = await this.resolveAuthorizationSubject(request);
			if (!subject) return new Response("authentication required", { status: 401 });
			const result = await this.server.authorize({
				clientId,
				redirectUri,
				codeChallenge: url.searchParams.get("code_challenge") ?? "",
				codeChallengeMethod: (url.searchParams.get("code_challenge_method") ?? "") as "S256",
				scope: scopes(url.searchParams.get("scope")),
				subject: subject.subject,
				tenantId: subject.tenantId,
				brainIds: subject.brainIds,
				...(state === null ? {} : { state }),
				nonce: url.searchParams.get("nonce") ?? undefined,
			});
			const target = new URL(result.redirectUri);
			target.searchParams.set("code", result.code);
			if (result.state !== undefined) target.searchParams.set("state", result.state);
			return Response.redirect(target, 302);
		} catch (cause) {
			const description = cause instanceof Error ? cause.message : "invalid authorization request";
			return safeRedirect ? redirectWithError(safeRedirect, "invalid_request", description, state) : errorResponse(400, "invalid_request", description);
		}
	}

	private async token(request: Request): Promise<Response> {
		try {
			const values = await form(request);
			const grantType = values.get("grant_type");
			if (grantType === "authorization_code") {
				const result = await this.server.redeemCode({
					clientId: values.get("client_id") ?? "",
					code: values.get("code") ?? "",
					redirectUri: values.get("redirect_uri") ?? "",
					codeVerifier: values.get("code_verifier") ?? "",
					clientSecret: values.get("client_secret") ?? undefined,
				});
				return json(tokenPayload(result));
			}
			if (grantType === "refresh_token") {
				const requestedScope = values.get("scope");
				const result = await this.server.refresh(values.get("refresh_token") ?? "", requestedScope ? scopes(requestedScope) : undefined);
				return json(tokenPayload(result));
			}
			return errorResponse(400, "unsupported_grant_type", "only authorization_code and refresh_token are supported");
		} catch (cause) {
			return errorResponse(400, "invalid_grant", cause instanceof Error ? cause.message : "invalid token request");
		}
	}

	private async revoke(request: Request): Promise<Response> {
		try {
			const values = await form(request);
			if (!values.get("token")) throw new Error("token is required");
			await this.server.revoke(values.get("token") as string);
			return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
		} catch (cause) {
			return errorResponse(400, "invalid_request", cause instanceof Error ? cause.message : "invalid request");
		}
	}

	private async introspect(request: Request): Promise<Response> {
		try {
			const values = await form(request);
			if (!values.get("token")) throw new Error("token is required");
			const result = await this.server.introspect(values.get("token") as string);
			return json({ active: result.active, ...(result.subject ? { sub: result.subject } : {}), ...(result.tenantId ? { tenant_id: result.tenantId } : {}), ...(result.brainIds?.length ? { brain_ids: result.brainIds } : {}), ...(result.scope ? { scope: result.scope.join(" ") } : {}) });
		} catch (cause) {
			return errorResponse(400, "invalid_request", cause instanceof Error ? cause.message : "invalid request");
		}
	}
}
