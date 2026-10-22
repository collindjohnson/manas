import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { beginGoogleAuthorization, refreshGoogleCredential } from "../src/sources/google-oauth";
const client = { clientId: "123-example.apps.googleusercontent.com", clientSecret: "desktop-client-secret" };
const input = { client, services: ["gmail" as const], email: "selected@example.invalid", redirectUri: "http://127.0.0.1:45678/google/callback" };
const scope = "openid email https://www.googleapis.com/auth/gmail.readonly";
const response = () => ({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, token_type: "Bearer", scope });
function callback(url: string) { return input.redirectUri + "?code=private-code&state=" + new URL(url).searchParams.get("state"); }
test("Google desktop authorization binds PKCE, selected account, read-only scopes, and a single use callback", async () => {
 let challenge = "", calls = 0;
 const flow = beginGoogleAuthorization(input, async (url, init) => {
  calls++;
  expect(init.redirect).toBe("error");
  if (url.endsWith("/token")) {
   expect(init.method).toBe("POST");
   const body = new URLSearchParams(String(init.body));
   expect(body.get("client_secret")).toBe(client.clientSecret);
   expect(body.get("redirect_uri")).toBe(input.redirectUri);
   expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(challenge);
   return Response.json(response());
  }
  expect(url).toBe("https://openidconnect.googleapis.com/v1/userinfo");
  expect(init.headers).toMatchObject({ Authorization: "Bearer private-access" });
  return Response.json({ sub: "stable-subject", email: input.email, email_verified: true });
 });
 const auth = new URL(flow.url);
 challenge = auth.searchParams.get("code_challenge")!;
 expect(auth.origin).toBe("https://accounts.google.com");
 expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
 expect(auth.searchParams.get("scope")!.split(" ").sort()).toEqual(scope.split(" ").sort());
 expect(flow.url).not.toContain(client.clientSecret);
 await expect(flow.complete(input.redirectUri + "?code=private-code&state=wrong")).rejects.toMatchObject({ code: "oauth_state_mismatch" });
 const credential = await flow.complete(callback(flow.url));
 expect(credential.accountId).toBe(createHash("sha256").update("google:stable-subject").digest("hex"));
 expect(credential.refreshToken).toBe("private-refresh");
 await expect(flow.complete(callback(flow.url))).rejects.toMatchObject({ code: "oauth_exchange_expired" });
 expect(calls).toBe(2);
});
test("Google authorization rejects redirect tampering, unverified or different accounts, missing offline grants, and write scopes", async () => {
 expect(() => beginGoogleAuthorization({ ...input, redirectUri: "https://example.invalid/google/callback" })).toThrow("invalid_loopback_redirect");
 expect(() => beginGoogleAuthorization({ ...input, services: ["drive" as "gmail"] })).toThrow("invalid_service_selection");
 for (const kind of ["different", "unverified", "no-refresh", "write", "extra-read"]) {
  const flow = beginGoogleAuthorization(input, async (url) => {
   if (url.endsWith("/token")) return Response.json({ ...response(), ...(kind === "no-refresh" ? { refresh_token: undefined } : {}), ...(kind === "write" ? { scope: scope + " https://www.googleapis.com/auth/gmail.modify" } : {}), ...(kind === "extra-read" ? { scope: scope + " https://www.googleapis.com/auth/calendar.readonly" } : {}) });
   return Response.json({ sub: "stable-subject", email: kind === "different" ? "other@example.invalid" : input.email, email_verified: kind !== "unverified" });
  });
  await expect(flow.complete(callback(flow.url))).rejects.toThrow();
 }
});
test("Google refresh preserves an omitted refresh token and rejects changed identities and sanitized failures", async () => {
 const flow = beginGoogleAuthorization(input, async (url) => Response.json(url.endsWith("/token") ? response() : { sub: "stable-subject", email: input.email, email_verified: true }));
 const credential = await flow.complete(callback(flow.url));
 const refreshed = await refreshGoogleCredential(credential, async (url, init) => {
  if (url.endsWith("/token")) {
   expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("private-refresh");
   return Response.json({ ...response(), refresh_token: undefined, access_token: "refreshed", scope: undefined });
  }
  return Response.json({ sub: "stable-subject", email: input.email, email_verified: true });
 });
 expect(refreshed.refreshToken).toBe("private-refresh");
 expect(refreshed.accessToken).toBe("refreshed");
 await expect(refreshGoogleCredential(credential, async (url) => Response.json(url.endsWith("/token") ? response() : { sub: "another-subject", email: input.email, email_verified: true }))).rejects.toMatchObject({ code: "selected_account_mismatch" });
 try { await refreshGoogleCredential(credential, async () => new Response("private-server-response", { status: 400 })); throw new Error("missing failure"); }
 catch (error) { expect(String(error)).toContain("oauth_http_400"); expect(String(error)).not.toContain("private-server-response"); expect(String(error)).not.toContain("private-refresh"); }
});
