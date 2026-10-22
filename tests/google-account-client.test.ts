import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { createGoogleAccountClient } from "../src/sources/google-account-client";
import type { GoogleCredential } from "../src/sources/google-oauth";
import type { GoogleBoundary } from "../src/sources/google-pages";
const accountId = createHash("sha256").update("google:subject").digest("hex");
const boundary: GoogleBoundary = { accountId, accountEmail: "owner@example.invalid", visibility: ["personal"], service: "contacts", groupIds: [], allContacts: true };
const credential: GoogleCredential = { version: 1, accountId, subject: "subject", email: boundary.accountEmail, clientId: "123-example.apps.googleusercontent.com", clientSecret: "secret", refreshToken: "refresh", accessToken: "expired", expiresAt: 0, scopes: ["openid", "email", "https://www.googleapis.com/auth/contacts.readonly"] };
test("selected Google clients serialize refresh and persist verified tokens before ingestion", async () => {
 let stored = structuredClone(credential), refreshes = 0, writes = 0;
 const credentials = {
  get: async () => structuredClone(stored),
  replace: async (expected: GoogleCredential, replacement: GoogleCredential) => { expect(expected.accessToken).toBe(stored.accessToken); writes++; stored = structuredClone(replacement); },
 };
 const fetcher = async (url: string, init: RequestInit) => {
  if (url.endsWith("/token")) { refreshes++; return Response.json({ access_token: "fresh", token_type: "Bearer", expires_in: 3600 }); }
  if (url.endsWith("/userinfo")) return Response.json({ sub: "subject", email: boundary.accountEmail, email_verified: true });
  expect(writes).toBe(1);
  expect(init.headers).toMatchObject({ Authorization: "Bearer fresh" });
  return Response.json({ connections: [] });
 };
 const options = { credentials, boundary, assertAccess: async () => {}, fetcher };
 const first = createGoogleAccountClient(options), second = createGoogleAccountClient(options);
 await Promise.all([first.get("contacts", "people/me/connections"), second.get("contacts", "people/me/connections")]);
 expect(refreshes).toBe(1); expect(writes).toBe(1);
 await expect(first.get("gmail", "profile")).rejects.toMatchObject({ code: "selected_service_mismatch" });
});
test("selected Google clients reject mismatched grants and discard responses after revocation", async () => {
 let enabled = true, requests = 0, stored = { ...credential, accessToken: "fresh", expiresAt: Date.now() + 3600000 };
 const credentials = { get: async () => structuredClone(stored), replace: async () => {} };
 const make = () => createGoogleAccountClient({ credentials, boundary, assertAccess: async () => { if (!enabled) throw new Error("source disabled"); }, fetcher: async () => { requests++; enabled = false; return Response.json({ private: "must be discarded" }); } });
 await expect(make().get("contacts", "people/me/connections")).rejects.toThrow("source disabled");
 enabled = true; stored = { ...stored, email: "other@example.invalid" };
 await expect(make().get("contacts", "people/me/connections")).rejects.toMatchObject({ code: "selected_account_or_scope_mismatch" });
 expect(requests).toBe(1);
});

test("Google account clients refresh a rejected token once and retain retryable provider failures", async () => {
 let stored = { ...credential, accessToken: "old", expiresAt: Date.now() + 3600000 }, refreshes = 0, requests = 0;
 const credentials = { get: async () => structuredClone(stored), replace: async (_expected: GoogleCredential, next: GoogleCredential) => { stored = next; } };
 const client = createGoogleAccountClient({ credentials, boundary, assertAccess: async () => {}, fetcher: async (url) => {
  if (url.endsWith("/token")) { refreshes++; return Response.json({ access_token: "fresh", token_type: "Bearer", expires_in: 3600 }); }
  if (url.endsWith("/userinfo")) return Response.json({ sub: "subject", email: boundary.accountEmail, email_verified: true });
  return ++requests === 1 ? new Response("", { status: 401 }) : Response.json({ connections: [] });
 } });
 await client.get("contacts", "people/me/connections");
 expect(refreshes).toBe(1); expect(requests).toBe(2);
 stored = { ...stored, expiresAt: 0 };
 const unavailable = createGoogleAccountClient({ credentials, boundary, assertAccess: async () => {}, fetcher: async () => new Response("private provider failure", { status: 503 }) });
 await expect(unavailable.get("contacts", "people/me/connections")).rejects.toMatchObject({ code: "oauth_http_503", retryable: true });
});
