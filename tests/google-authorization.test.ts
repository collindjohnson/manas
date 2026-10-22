import { test, expect } from "bun:test";
import { authorizeGoogleAccount } from "../src/sources/google-authorization";
const client = { clientId: "123-example.apps.googleusercontent.com", clientSecret: "desktop-secret" };
const scope = "openid email https://www.googleapis.com/auth/contacts.readonly";
test("Google loopback authorization ignores forged callbacks and completes verified consent", async () => {
 let callbackStatus = 0;
 let browserTask: Promise<void> = Promise.resolve();
 const credential = await authorizeGoogleAccount({
  client, services: ["contacts"], email: "owner@example.invalid",
  fetcher: async (url) => Response.json(url.endsWith("/token") ? { access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600, scope } : { sub: "subject", email: "owner@example.invalid", email_verified: true }),
  openBrowser: (address) => browserTask = (async () => {
   const auth = new URL(address), callback = auth.searchParams.get("redirect_uri")!;
   expect(new URL(callback).hostname).toBe("127.0.0.1");
   expect((await fetch(callback + "?state=forged&code=bad")).status).toBe(400);
   expect((await fetch(callback + "?state=" + auth.searchParams.get("state") + "&code=code", { method: "POST" })).status).toBe(400);
   const response = await fetch(callback + "?state=" + auth.searchParams.get("state") + "&code=code");
   callbackStatus = response.status;
   expect(await response.text()).not.toContain("refresh");
  })(),
 });
 await browserTask;
 expect(credential.email).toBe("owner@example.invalid");
 // The successful callback response remains readable after authorization resolves.
 expect(callbackStatus).toBe(200);
});
test("Google loopback authorization closes on cancellation, timeout, or browser failure", async () => {
 const abort = new AbortController();
 await expect(authorizeGoogleAccount({ client, services: ["contacts"], email: "owner@example.invalid", signal: abort.signal, openBrowser: async () => { abort.abort(); } })).rejects.toMatchObject({ code: "authorization_cancelled" });
 await expect(authorizeGoogleAccount({ client, services: ["contacts"], email: "owner@example.invalid", timeoutMs: 100, openBrowser: async () => {} })).rejects.toMatchObject({ code: "authorization_timeout" });
 await expect(authorizeGoogleAccount({ client, services: ["contacts"], email: "owner@example.invalid", openBrowser: async () => { throw new Error("private-browser-details"); } })).rejects.toMatchObject({ code: "browser_unavailable" });
});
