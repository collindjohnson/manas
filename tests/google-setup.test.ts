import { GoogleApiError } from "../src/sources/google-api";
import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { BrainRepository } from "../src/brain/repository";
import { openPgliteBrainStore } from "../src/brain/store";
import { connectGoogleAccount } from "../src/brain/google-setup";
import { createFullOperationRegistry } from "../src/brain/operation-catalog";
import { googleSourceStatus } from "../src/brain/google-jobs";
import type { GoogleCredential } from "../src/sources/google-oauth";
const credential: GoogleCredential = { version: 1, accountId: createHash("sha256").update("google:subject").digest("hex"), subject: "subject", email: "owner@example.invalid", clientId: "123-example.apps.googleusercontent.com", clientSecret: "private-client-secret", refreshToken: "private-refresh", accessToken: "private-access", expiresAt: Date.now() + 3600000, scopes: ["openid", "email", "https://www.googleapis.com/auth/contacts.readonly"] };
const owner = { scope: "admin" as const, principal: "setup-owner" };
const selections = [{ service: "contacts" as const, visibility: ["personal"], groupIds: ["contactGroups/selected"], allContacts: false }];
async function fixture(action: (context: { root: string; store: Awaited<ReturnType<typeof openPgliteBrainStore>>; repository: BrainRepository; clientFile: string }) => Promise<void>) {
 const root = await mkdtemp(join(tmpdir(), "manas-google-setup-")), store = await openPgliteBrainStore(join(root, "state")), repository = new BrainRepository(join(root, "brain")), clientFile = join(root, "desktop-client.json");
 try {
  await repository.initialize();
  await writeFile(clientFile, JSON.stringify({ installed: { client_id: credential.clientId, client_secret: credential.clientSecret } }), { mode: 0o600 });
  await action({ root, store, repository, clientFile });
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}
test("owner Google connection binds selected consent and registers sources without exposing credentials or starting ingestion", async () => fixture(async (dependencies) => {
 let stored: GoogleCredential | undefined, authorizations = 0;
 const credentials = { get: async () => { if (!stored) throw new GoogleApiError("credential_not_found", 401, false); return structuredClone(stored); }, replace: async () => {}, put: async (value: GoogleCredential) => { stored = structuredClone(value); } };
 const registry = createFullOperationRegistry({ repository: dependencies.repository, store: dependencies.store, googleCredentials: credentials, googleAuthorization: async (options) => {
  authorizations++;
  expect(options.client).toEqual({ clientId: credential.clientId, clientSecret: credential.clientSecret });
  expect(options.services).toEqual(["contacts"]);
  expect(options.email).toBe(credential.email);
  return structuredClone(credential);
 } });
 expect(registry.get("google.accounts.connect")).toMatchObject({ requiredScope: "admin", trustBoundary: "local-only" });
 const result = await registry.execute(owner, "google.accounts.connect", { clientFile: dependencies.clientFile, email: credential.email, boundaries: selections });
 expect(result).toMatchObject({ accountId: credential.accountId, credentialsStored: true, ingestionStarted: false, sources: [{ enabled: true }] });
 expect(JSON.stringify(result)).not.toContain("private-");
 expect(authorizations).toBe(1);
 expect(stored!.refreshToken).toBe("private-refresh");
 expect((await googleSourceStatus({ ...dependencies, credentials }, owner)).sources).toHaveLength(1);
 expect(await dependencies.store.query("SELECT id FROM brain_jobs")).toHaveLength(0);
 expect(await dependencies.repository.listPages()).toHaveLength(0);
}), 15000);
test("Google setup rejects unsafe files, unselected identities, unauthorized labels, and cancellation before persistence", async () => fixture(async (dependencies) => {
 let authorizations = 0, writes = 0;
 const credentials = { get: async () => credential, replace: async () => {}, put: async () => { writes++; } };
 const authorize = async () => { authorizations++; return structuredClone(credential); };
 const options = { ...dependencies, credentials, authorize };
 const input = { clientFile: dependencies.clientFile, email: credential.email, boundaries: selections };
 await expect(connectGoogleAccount(options, { scope: "write" }, input)).rejects.toMatchObject({ code: "owner_access_required" });
 await expect(connectGoogleAccount(options, { ...owner, allowedAccessLabels: [] }, input)).rejects.toMatchObject({ code: "source_visibility_denied" });
 const linked = join(dependencies.root, "linked.json"); await symlink(dependencies.clientFile, linked);
 await expect(connectGoogleAccount(options, owner, { ...input, clientFile: linked })).rejects.toMatchObject({ code: "invalid_desktop_client_file" });
 await expect(connectGoogleAccount(options, owner, { ...input, boundaries: [{ ...selections[0]!, accountId: credential.accountId }] } as never)).rejects.toMatchObject({ code: "invalid_boundary_selection" });
 expect(authorizations).toBe(0);
 await expect(connectGoogleAccount({ ...options, authorize: async () => ({ ...credential, email: "other@example.invalid" }) }, owner, input)).rejects.toMatchObject({ code: "selected_account_mismatch" });
 const abort = new AbortController();
 await expect(connectGoogleAccount({ ...options, authorize: async () => { abort.abort(); return structuredClone(credential); } }, { ...owner, signal: abort.signal }, input)).rejects.toMatchObject({ code: "authorization_cancelled" });
 expect(writes).toBe(0);
 expect((await googleSourceStatus(dependencies, owner)).sources).toHaveLength(0);
}), 15000);

test("Google reconnect cannot drop existing service grants or register sources after credential storage failure", async () => fixture(async (dependencies) => {
 let writes = 0;
 const credentials = { get: async () => ({ ...credential, scopes: [...credential.scopes, "https://www.googleapis.com/auth/calendar.readonly"] }), replace: async () => {}, put: async () => { writes++; } };
 const input = { clientFile: dependencies.clientFile, email: credential.email, boundaries: selections };
 await expect(connectGoogleAccount({ ...dependencies, credentials, authorize: async () => structuredClone(credential) }, owner, input)).rejects.toMatchObject({ code: "existing_service_grants_required" });
 expect(writes).toBe(0);
 const unavailable = { get: async () => { throw new GoogleApiError("credential_not_found", 401, false); }, replace: async () => {}, put: async () => { throw new GoogleApiError("keychain_unavailable", 401, false); } };
 await expect(connectGoogleAccount({ ...dependencies, credentials: unavailable, authorize: async () => structuredClone(credential) }, owner, input)).rejects.toMatchObject({ code: "keychain_unavailable" });
 expect((await googleSourceStatus(dependencies, owner)).sources).toHaveLength(0);
}), 15000);
