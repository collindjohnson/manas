import { beginGoogleAuthorization, type GoogleDesktopClient, type GoogleService, type GoogleCredential } from "./google-oauth";
import { GoogleApiError } from "./google-api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
/** Opens an explicit owner-initiated consent flow; returns credentials only after identity verification. */
export async function authorizeGoogleAccount(options: {
 client: GoogleDesktopClient; services: GoogleService[]; email: string; signal?: AbortSignal;
 openBrowser?: (url: string) => Promise<void>; fetcher?: Fetcher; timeoutMs?: number;
}): Promise<GoogleCredential> {
 const timeoutMs = options.timeoutMs ?? 300000;
 if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new GoogleApiError("invalid_authorization_timeout", 0, false);
 if (options.signal?.aborted) throw new GoogleApiError("authorization_cancelled", 0, false);
 let resolve!: (credential: GoogleCredential) => void, reject!: (error: unknown) => void;
 const result = new Promise<GoogleCredential>((yes, no) => { resolve = yes; reject = no; });
 // Attach a rejection handler before browser launch, which may itself take time.
 void result.catch(() => {});
 let settled = false, succeeded = false, inFlight = false;
 let flow: ReturnType<typeof beginGoogleAuthorization> | undefined;
 const finish = (error?: unknown, credential?: GoogleCredential) => {
  if (settled) return;
  settled = true; succeeded = Boolean(credential);
  if (error) reject(error); else resolve(credential!);
 };
 const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
   const url = new URL(request.url);
   const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" };
   if (!flow || request.method !== "GET" || url.hostname !== "127.0.0.1" || url.port !== String(server.port) || url.pathname !== "/google/callback" || request.headers.has("origin")) return new Response("Invalid authorization callback.", { status: 400, headers });
   if (settled || inFlight) return new Response("Authorization is already processing or closed.", { status: 409, headers });
   // Invalid state cannot consume or terminate the owner's pending exchange.
   const expected = new URL(flow.url).searchParams.get("state");
   if (url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== expected) return new Response("Invalid authorization state.", { status: 400, headers });
   inFlight = true;
   try {
    const credential = await flow.complete(url.href);
    if (settled) return new Response("Authorization expired or was cancelled.", { status: 410, headers });
    finish(undefined, credential);
    return new Response("Google account verified. Return to Manas to select ingestion boundaries.", { headers });
   } catch (error) {
    finish(error instanceof GoogleApiError ? error : new GoogleApiError("authorization_failed", 0, false));
    return new Response("Google authorization failed. Return to Manas and retry setup.", { status: 400, headers });
   }
  },
 });
 const abort = () => finish(new GoogleApiError("authorization_cancelled", 0, false));
 const timer = setTimeout(() => finish(new GoogleApiError("authorization_timeout", 0, false)), timeoutMs);
 options.signal?.addEventListener("abort", abort, { once: true });
 try {
  flow = beginGoogleAuthorization({ client: options.client, services: options.services, email: options.email, redirectUri: "http://127.0.0.1:" + server.port + "/google/callback" }, options.fetcher);
  if (options.signal?.aborted) abort();
  if (!settled) {
   const open = options.openBrowser ?? (async (url: string) => {
    if (process.platform !== "darwin") throw new GoogleApiError("macos_required", 0, false);
    try { await run("/usr/bin/open", [url], { timeout: 10000, maxBuffer: 4096 }); } catch { throw new GoogleApiError("browser_unavailable", 0, false); }
   });
   void Promise.resolve().then(() => open(flow!.url)).catch(() => finish(new GoogleApiError("browser_unavailable", 0, false)));
  }
  return await result;
 } finally {
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", abort);
  await server.stop(!succeeded);
 }
}
