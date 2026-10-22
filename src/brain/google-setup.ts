import { open, constants } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { BrainStore } from "./store";
import type { BrainRepository } from "./repository";
import type { OperationContext } from "./operation-registry";
import { addGoogleSource, runtimeGoogleCredentials } from "./google-jobs";
import { authorizeGoogleAccount } from "../sources/google-authorization";
import { validateGoogleBoundary, type GoogleBoundary } from "../sources/google-pages";
import { validateGoogleCredential, type GoogleCredential } from "../sources/google-oauth";
import type { GoogleCredentialAccess } from "../sources/google-account-client";
import { GoogleApiError } from "../sources/google-api";

export type GoogleBoundarySelection = GoogleBoundary extends infer B ? B extends GoogleBoundary ? Omit<B, "accountId" | "accountEmail"> : never : never;
type Dependencies = {
 store: BrainStore; repository: BrainRepository;
 credentials?: GoogleCredentialAccess & { put?: (credential: GoogleCredential) => Promise<void> };
 authorize?: typeof authorizeGoogleAccount;
};
async function readDesktopClient(path: string) {
 if (typeof path !== "string" || !isAbsolute(path)) throw new GoogleApiError("select_desktop_client_file", 0, false);
 let file: Awaited<ReturnType<typeof open>> | undefined;
 try {
  file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > 16384 || stat.uid !== process.getuid?.() || stat.mode & 0o022) throw new Error("unsafe client file");
  const buffer = Buffer.alloc(16385);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead > 16384) throw new Error("oversized client file");
  const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  if (!document?.installed || document.web || typeof document.installed.client_id !== "string" || typeof document.installed.client_secret !== "string") throw new Error("desktop client required");
  return { clientId: document.installed.client_id, clientSecret: document.installed.client_secret };
 } catch { throw new GoogleApiError("invalid_desktop_client_file", 0, false); }
 finally { await file?.close(); }
}
/** Explicit owner consent only. Returns metadata; secret material never enters catalog results. */
export async function connectGoogleAccount(dependencies: Dependencies, context: OperationContext, input: { clientFile: string; email: string; boundaries: GoogleBoundarySelection[] }) {
 const brainId = (await dependencies.repository.getIdentity()).brainId;
 if (context.scope !== "admin" || context.tenantId && context.tenantId !== "local" || context.brainId && context.brainId !== brainId) throw new GoogleApiError("owner_access_required", 403, false);
 if (!Array.isArray(input.boundaries) || !input.boundaries.length || input.boundaries.length > 20 || typeof input.email !== "string") throw new GoogleApiError("select_ingestion_boundaries", 0, false);
 const boundaries = input.boundaries.map((selection) => {
  if (!selection || Object.hasOwn(selection, "accountId") || Object.hasOwn(selection, "accountEmail")) throw new GoogleApiError("invalid_boundary_selection", 0, false);
  const boundary = validateGoogleBoundary({ ...selection, accountId: "0".repeat(64), accountEmail: input.email } as GoogleBoundary);
  if (context.allowedAccessLabels && boundary.visibility.some((label) => !context.allowedAccessLabels!.includes(label))) throw new GoogleApiError("source_visibility_denied", 403, false);
  return structuredClone(selection);
 });
 const credentials = dependencies.credentials ?? runtimeGoogleCredentials;
 if (!credentials.put) throw new GoogleApiError("credential_storage_unavailable", 0, false);
 const client = await readDesktopClient(input.clientFile);
 const services = [...new Set(boundaries.map((boundary) => boundary.service))];
 const credential = validateGoogleCredential(await (dependencies.authorize ?? authorizeGoogleAccount)({ client, services, email: input.email, signal: context.signal }));
 if (credential.email.toLowerCase() !== input.email.toLowerCase() || credential.clientId !== client.clientId || credential.clientSecret !== client.clientSecret) throw new GoogleApiError("selected_account_mismatch", 403, false);
 const serviceScopes = { gmail: "https://www.googleapis.com/auth/gmail.readonly", calendar: "https://www.googleapis.com/auth/calendar.readonly", contacts: "https://www.googleapis.com/auth/contacts.readonly" };
 if (services.some((service) => !credential.scopes.includes(serviceScopes[service]))) throw new GoogleApiError("oauth_scope_mismatch", 403, false);
 let previous: GoogleCredential | undefined;
 try { previous = validateGoogleCredential(await credentials.get(credential.accountId)); }
 catch (error) { if (!(error instanceof GoogleApiError) || error.code !== "credential_not_found") throw error; }
 if (previous && previous.scopes.some((scope) => Object.values(serviceScopes).includes(scope) && !credential.scopes.includes(scope))) throw new GoogleApiError("existing_service_grants_required", 403, false);
 if (context.signal?.aborted) throw new GoogleApiError("authorization_cancelled", 0, false);
 await credentials.put(credential);
 // If registration fails, the verified credential remains in Keychain; no source is partly registered.
 const sources = await dependencies.store.transaction(async (transaction) => {
  if (context.signal?.aborted) throw new GoogleApiError("authorization_cancelled", 0, false);
  const registered = [];
  const frozenCredentials = { get: async () => structuredClone(credential), replace: credentials.replace.bind(credentials) };
  for (const selection of boundaries) {
   if (context.signal?.aborted) throw new GoogleApiError("authorization_cancelled", 0, false);
   registered.push(await addGoogleSource({ store: transaction, repository: dependencies.repository, credentials: frozenCredentials }, context, { ...selection, accountId: credential.accountId, accountEmail: credential.email } as GoogleBoundary));
  }
  if (context.signal?.aborted) throw new GoogleApiError("authorization_cancelled", 0, false);
  return registered;
 });
 return { accountId: credential.accountId, email: credential.email, services, sources, credentialsStored: true, ingestionStarted: false };
}
