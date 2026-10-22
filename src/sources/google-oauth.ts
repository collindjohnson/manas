import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { GoogleApiError } from "./google-api";

export type GoogleService = "gmail" | "calendar" | "contacts";
const serviceScopes: Record<GoogleService, string> = {
 gmail: "https://www.googleapis.com/auth/gmail.readonly",
 calendar: "https://www.googleapis.com/auth/calendar.readonly",
 contacts: "https://www.googleapis.com/auth/contacts.readonly",
};
export type GoogleDesktopClient = { clientId: string; clientSecret: string };
export type GoogleCredential = { version: 1; accountId: string; subject: string; email: string; clientId: string; clientSecret: string; refreshToken: string; accessToken: string; expiresAt: number; scopes: string[] };
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const safe = (value: unknown, max = 8192): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
function fail(code: string): never { throw new GoogleApiError(code, 401, false); }
function client(input: GoogleDesktopClient) {
 if (!safe(input.clientId, 256) || !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(input.clientId) || !safe(input.clientSecret, 1024)) fail("invalid_desktop_client");
}
function scopes(services: GoogleService[]) {
 if (!Array.isArray(services) || !services.length || services.length > 3 || services.some((value) => !Object.hasOwn(serviceScopes, value)) || new Set(services).size !== services.length) fail("invalid_service_selection");
 return ["openid", "email", ...services.map((value) => serviceScopes[value])].sort();
}
async function request(fetcher: Fetcher, url: string, init: RequestInit) {
 let response: Response;
 try { response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20000) }); } catch { throw new GoogleApiError("network_unavailable", 0, true, 1000); }
 if (!response.ok || response.redirected) { await response.body?.cancel(); throw new GoogleApiError("oauth_http_" + response.status, response.status, response.status === 429 || response.status >= 500, 1000); }
 const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
 let size = 0;
 try {
  if (reader) while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) fail("oauth_response_too_large"); chunks.push(part.value); }
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("invalid_oauth_response");
  return body as Record<string, unknown>;
 } catch (error) { await reader?.cancel().catch(() => {}); if (error instanceof GoogleApiError) throw error; fail("invalid_oauth_response"); }
}
async function identity(fetcher: Fetcher, accessToken: string) {
 const profile = await request(fetcher, "https://openidconnect.googleapis.com/v1/userinfo", { method: "GET", headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" } });
 if (!safe(profile.sub, 255) || !safe(profile.email, 254) || !/^[^\s@]+@[^\s@]+$/.test(profile.email) || profile.email_verified !== true) fail("unverified_account");
 return { subject: profile.sub, email: profile.email, accountId: sha("google:" + profile.sub) };
}
function token(body: Record<string, unknown>, requiredScopes: string[], previous?: GoogleCredential) {
 if (!safe(body.access_token) || body.token_type !== "Bearer" || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in < 60 || body.expires_in > 86400) fail("invalid_oauth_token");
 const granted = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
 const permitted = new Set(["openid", "email", "https://www.googleapis.com/auth/userinfo.email", ...requiredScopes.filter((value) => Object.values(serviceScopes).includes(value))]);
 if (!granted || granted.some((value) => !permitted.has(value)) || requiredScopes.some((value) => !granted.includes(value) && !(value === "email" && granted.includes("https://www.googleapis.com/auth/userinfo.email")))) fail("oauth_scope_mismatch");
 const refreshToken = body.refresh_token ?? previous?.refreshToken;
 if (!safe(refreshToken)) fail("offline_access_missing");
 return { accessToken: body.access_token, refreshToken, expiresAt: Date.now() + body.expires_in * 1000, scopes: [...new Set(granted)].sort() };
}
/** Single-use, in-memory PKCE exchange. The caller owns the loopback listener and Keychain persistence. */
export function beginGoogleAuthorization(input: { client: GoogleDesktopClient; services: GoogleService[]; email: string; redirectUri: string }, fetcher: Fetcher = fetch) {
 client(input.client);
 if (!safe(input.email, 254) || !/^[^\s@]+@[^\s@]+$/.test(input.email)) fail("select_account");
 let redirect: URL;
 try { redirect = new URL(input.redirectUri); } catch { fail("invalid_loopback_redirect"); }
 if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== "/google/callback") fail("invalid_loopback_redirect");
 const config = { ...input.client }, selectedEmail = input.email.toLowerCase(), redirectUri = redirect.href;
 const requiredScopes = scopes([...input.services]), state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
 const challenge = createHash("sha256").update(verifier).digest("base64url"), expiresAt = Date.now() + 5 * 60 * 1000;
 const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
 for (const [key, value] of Object.entries({ client_id: config.clientId, redirect_uri: redirectUri, response_type: "code", scope: requiredScopes.join(" "), code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent select_account", login_hint: input.email })) url.searchParams.set(key, value);
 let consumed = false;
 return { url: url.href, expiresAt, async complete(callbackUrl: string): Promise<GoogleCredential> {
  let callback: URL;
  try { callback = new URL(callbackUrl); } catch { fail("invalid_oauth_callback"); }
  if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.hash || callback.username || callback.password) fail("invalid_oauth_callback");
  const returnedState = callback.searchParams.getAll("state");
  if (returnedState.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(returnedState[0]!) || !timingSafeEqual(Buffer.from(returnedState[0]!), Buffer.from(state))) fail("oauth_state_mismatch");
  if (consumed || Date.now() >= expiresAt) fail("oauth_exchange_expired");
  consumed = true;
  if (callback.searchParams.has("error")) fail("oauth_consent_denied");
  const code = callback.searchParams.getAll("code");
  if (code.length !== 1 || !safe(code[0])) fail("invalid_oauth_code");
  const body = await request(fetcher, "https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code: code[0]!, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri }).toString() });
  const credentials = token(body, requiredScopes), account = await identity(fetcher, credentials.accessToken);
  if (account.email.toLowerCase() !== selectedEmail) fail("selected_account_mismatch");
  return { version: 1, ...account, ...config, ...credentials };
 } };
}
export function validateGoogleCredential(value: GoogleCredential): GoogleCredential {
 if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_stored_credentials");
 client(value);
 const allowed = new Set(["version", "accountId", "subject", "email", "clientId", "clientSecret", "refreshToken", "accessToken", "expiresAt", "scopes"]);
 const validScopes = new Set(["openid", "email", "https://www.googleapis.com/auth/userinfo.email", ...Object.values(serviceScopes)]);
 if (Object.keys(value).some((key) => !allowed.has(key)) || value.version !== 1 || !safe(value.refreshToken) || !safe(value.accessToken) || !safe(value.subject, 255) || !safe(value.email, 254) || !/^[^\s@]+@[^\s@]+$/.test(value.email) || value.accountId !== sha("google:" + value.subject) || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || !Array.isArray(value.scopes) || value.scopes.length > 5 || value.scopes.some((scope) => typeof scope !== "string" || !validScopes.has(scope)) || !value.scopes.includes("openid") || !value.scopes.some((scope) => scope === "email" || scope === "https://www.googleapis.com/auth/userinfo.email") || !value.scopes.some((scope) => Object.values(serviceScopes).includes(scope))) fail("invalid_stored_credentials");
 return value;
}
export async function refreshGoogleCredential(previous: GoogleCredential, fetcher: Fetcher = fetch): Promise<GoogleCredential> {
 validateGoogleCredential(previous);
 const body = await request(fetcher, "https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ client_id: previous.clientId, client_secret: previous.clientSecret, refresh_token: previous.refreshToken, grant_type: "refresh_token" }).toString() });
 const credentials = token(body, previous.scopes, previous), account = await identity(fetcher, credentials.accessToken);
 if (account.accountId !== previous.accountId || account.email.toLowerCase() !== previous.email.toLowerCase()) fail("selected_account_mismatch");
 return { ...previous, ...credentials };
}
