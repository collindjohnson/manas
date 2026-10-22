import { GoogleReadClient, GoogleApiError } from "./google-api";
import { refreshGoogleCredential, validateGoogleCredential, type GoogleCredential } from "./google-oauth";
import { validateGoogleBoundary, type GoogleBoundary } from "./google-pages";

export interface GoogleCredentialAccess {
 get(accountId: string): Promise<GoogleCredential>;
 replace(expected: GoogleCredential, replacement: GoogleCredential): Promise<void>;
}
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const scopes = { gmail: "https://www.googleapis.com/auth/gmail.readonly", calendar: "https://www.googleapis.com/auth/calendar.readonly", contacts: "https://www.googleapis.com/auth/contacts.readonly" };
const queues = new WeakMap<GoogleCredentialAccess, Map<string, Promise<void>>>();
async function serialized<T>(store: GoogleCredentialAccess, accountId: string, action: () => Promise<T>): Promise<T> {
 let accounts = queues.get(store);
 if (!accounts) { accounts = new Map(); queues.set(store, accounts); }
 const previous = accounts.get(accountId) ?? Promise.resolve();
 let release!: () => void;
 const pending = new Promise<void>((resolve) => { release = resolve; });
 accounts.set(accountId, pending);
 await previous;
 try { return await action(); } finally { release(); if (accounts.get(accountId) === pending) accounts.delete(accountId); }
}
/** Bind every API call to a selected boundary; credentials remain in Keychain or process memory. */
export function createGoogleAccountClient(options: { credentials: GoogleCredentialAccess; boundary: GoogleBoundary; assertAccess: () => Promise<void>; fetcher?: Fetcher }): GoogleReadClient {
 const boundary = structuredClone(validateGoogleBoundary(options.boundary));
 let lastToken: string | undefined;
 const selected = (value: GoogleCredential) => {
  const credential = validateGoogleCredential(value);
  if (credential.accountId !== boundary.accountId || credential.email.toLowerCase() !== boundary.accountEmail.toLowerCase() || !credential.scopes.includes(scopes[boundary.service])) throw new GoogleApiError("selected_account_or_scope_mismatch", 403, false);
  return credential;
 };
 const provider = async (forceRefresh = false) => serialized(options.credentials, boundary.accountId, async () => {
  await options.assertAccess();
  let credential = selected(await options.credentials.get(boundary.accountId));
  if (credential.expiresAt <= Date.now() + 60000 || forceRefresh && credential.accessToken === lastToken) {
   const refreshed = selected(await refreshGoogleCredential(credential, options.fetcher));
   await options.assertAccess();
   // Compare-and-replace prevents an in-flight refresh from reviving disconnected credentials
   // or overwriting a newer interactive consent grant.
   await options.credentials.replace(credential, refreshed);
   credential = refreshed;
  }
  await options.assertAccess();
  lastToken = credential.accessToken;
  return credential.accessToken;
 });
 class SelectedGoogleClient extends GoogleReadClient {
  override async get(service: "gmail" | "calendar" | "contacts", resource: string, parameters: Record<string, string | string[] | undefined> = {}) {
   if (service !== boundary.service) throw new GoogleApiError("selected_service_mismatch", 403, false);
   await options.assertAccess();
   const response = await super.get(service, resource, parameters);
   await options.assertAccess();
   return response;
  }
 }
 return new SelectedGoogleClient(provider, options.fetcher);
}
