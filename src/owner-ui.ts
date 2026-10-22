import { isPrimaryEvidence, recordVisible } from "./brain/evidence-contract";
import type { Socket } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { BrainEngine } from "./engine";
import { createOwnerSession, authorizeOwnerSession, revokeOwnerSession, OwnerSessionError } from "./brain/owner-sessions";
import { diagnoseProvider } from "./brain/providers";
import html from "./owner-ui/index.html" with { type: "text" };
import javascript from "./owner-ui/app.js.txt" with { type: "text" };
import css from "./owner-ui/app.css" with { type: "text" };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const operations = new Set([
 "retrieval.search", "memory.remember", "memory.recall", "memory.correct", "memory.forget", "memory.history",
 "questions.put", "questions.get", "questions.list", "questions.refresh",
 "maintenance.scan", "maintenance.proposals", "maintenance.dismiss", "maintenance.accept", "entities.reviews", "entities.review.resolve", "entities.resolve",
 "jobs.list", "jobs.cancel", "jobs.schedules", "execution.list", "execution.status", "execution.cancel",
 "google.accounts.connect", "google.sources.status", "google.sources.enable", "google.sources.sync", "google.sources.schedule",
 "loops.put", "loops.get", "loops.list", "loops.status", "meetings.prepare", "meetings.get", "reminders.list", "reminders.enqueue",
 "admin.token.list", "admin.token.create", "admin.token.revoke", "admin.dashboard", "sources.list",
]);
class UiError extends Error {
 readonly retryable = false;
 constructor(readonly code: string, message: string, readonly suggestedFix = "Reload the page or run manas ui open to sign in again.") { super(message); }
}
function body(req: IncomingMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
 if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new UiError("invalid_content_type", "Use application/json.");
 signal.throwIfAborted();
 return new Promise((resolve, reject) => {
  const chunks: Buffer[] = []; let bytes = 0, done = false;
  signal.addEventListener("abort", () => { if (!done) { done = true; chunks.length = 0; reject(new UiError("request_aborted", "Browser request interrupted.")); } }, { once: true });
  req.on("data", (chunk: Buffer) => {
   if (done) return;
   bytes += chunk.length;
   if (bytes > 262144) { done = true; chunks.length = 0; reject(new UiError("request_too_large", "Browser requests are limited to 256 KiB.")); }
   else chunks.push(Buffer.from(chunk));
  });
  req.once("end", () => { if (!done) { done = true; try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); resolve(value); } catch { reject(new UiError("invalid_json", "An object request body is required.")); } } });
  req.once("error", (error) => { if (!done) { done = true; reject(error); } });
  req.once("aborted", () => { if (!done) { done = true; reject(new UiError("request_aborted", "Browser request interrupted.")); } });
 });
}
function json(res: ServerResponse, value: unknown) {
 const output = JSON.stringify(value);
 if (Buffer.byteLength(output) > 8388608) throw new UiError("response_too_large", "Request fewer results.");
 res.end(output);
}
export interface OwnerUi {
 origin: string;
 bootstrap(): { url: string; expiresAt: string };
 close(): Promise<void>;
}
export async function startOwnerUi(engine: BrainEngine, input: { port?: number } = {}): Promise<OwnerUi> {
 const port = input.port ?? 0;
 if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UiError("invalid_ui_port", "Choose a port from zero to 65535.");
 if (!engine.store) throw new UiError("operational_store_required", "Browser administration requires the service operational store.");
 const store = engine.store, brainId = (await engine.repository.getIdentity()).brainId;
 let origin = "", closed = false;
 let closing: Promise<void> | undefined;
 const sockets = new Set<Socket>();
 const tickets = new Map<string, number>(), active = new Set<AbortController>(), completions = new Set<Promise<void>>();
 const cookieName = "manas_owner_" + digest(brainId).slice(0, 16);
 const server = createServer(async (req, res) => {
  const abort = new AbortController(); active.add(abort);
  let finish!: () => void; const completion = new Promise<void>((resolve) => { finish = resolve; }); completions.add(completion);
  req.once("aborted", () => abort.abort());
  res.once("close", () => { if (!res.writableEnded) abort.abort(); });
  res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
   if (closed || req.headers.host !== new URL(origin).host || req.headers["x-forwarded-host"] || req.headers["x-forwarded-proto"]) throw new UiError("invalid_host", "Browser host is not authorized.");
   if (req.headers.origin && req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") throw new UiError("invalid_origin", "Cross-origin browser access is not authorized.");
   if (req.method === "GET" && ["/", "/app.js", "/app.css"].includes(req.url ?? "")) {
    if (req.url === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); }
    else if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript; charset=utf-8"); res.end(javascript); }
    else { res.setHeader("Content-Type", "text/css; charset=utf-8"); res.end(css); }
    return;
   }
   if (req.method !== "POST" || req.headers.origin !== origin) throw new UiError("invalid_request", "Use the same-origin browser interface.");
   const value = await body(req, abort.signal);
   if (req.url === "/api/login") {
    const ticket = typeof value.ticket === "string" ? value.ticket : "";
    const expiry = tickets.get(digest(ticket)); tickets.delete(digest(ticket));
    if (!expiry || expiry <= Date.now()) throw new OwnerSessionError();
    const session = await createOwnerSession(store, brainId, origin);
    res.setHeader("Set-Cookie", cookieName + "=" + session.id + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800");
    json(res, { ok: true, data: { csrf: session.csrf, expiresAt: session.absoluteExpiresAt } }); return;
   }
   const cookie = (req.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(cookieName + "="));
   if (cookie.length !== 1) throw new OwnerSessionError();
   const sessionId = cookie[0]!.slice(cookieName.length + 1), csrf = String(req.headers["x-manas-csrf"] ?? "");
   await authorizeOwnerSession(store, brainId, origin, sessionId, csrf);
   if (req.url === "/api/logout") {
    await revokeOwnerSession(store, brainId, sessionId);
    res.setHeader("Set-Cookie", cookieName + "=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    json(res, { ok: true, data: { signedOut: true } }); return;
   }
   const context = { scope: "admin" as const, principal: "owner-browser", tenantId: "local", brainId, signal: abort.signal };
   let data: unknown;
   if (req.url === "/api/status") {
    const snapshot = await engine.repository.snapshot();
    const projection = await store.query<{ git_commit: string }>("SELECT git_commit FROM brain_active_projection_runs WHERE tenant_id='local' AND brain_id=$1", [brainId]);
    const sourceGroups = new Map<string, { type: string; documents: number; lastImportedAt: string | null }>();
    for (const page of snapshot.pages.filter((page) => recordVisible(page, context) && isPrimaryEvidence(page))) {
     const type = page.source?.type ?? "manual", previous = sourceGroups.get(type) ?? { type, documents: 0, lastImportedAt: null };
     previous.documents++;
     const date = page.source?.provenance?.retrievedAt;
     if (date && Number.isFinite(Date.parse(date)) && (!previous.lastImportedAt || Date.parse(date) > Date.parse(previous.lastImportedAt))) previous.lastImportedAt = new Date(date).toISOString();
     sourceGroups.set(type, previous);
    }
    data = { brainId, repositoryRoot: engine.repository.root, commit: snapshot.commit, primaryDocuments: snapshot.pages.filter((page) => recordVisible(page, { scope: "admin" }) && isPrimaryEvidence(page)).length, projectionCurrent: projection[0]?.git_commit === snapshot.commit, providers: (["generation", "embedding", "reranking", "extraction", "transcription"] as const).map((kind) => ({ kind, configured: !!engine.providers[kind] })), sources: [...sourceGroups.values()].sort((a, b) => a.type.localeCompare(b.type)), managedWrites: engine.config.automation?.managedWrites === true };
   } else if (req.url === "/api/models") {
    data = await Promise.all(Object.entries(engine.config.providers ?? {}).map(async ([kind, provider]) => ({ kind, model: provider?.model ?? null, ...(provider ? await diagnoseProvider({ endpoint: provider.endpoint, privacy: "local", timeoutMs: 2000 }) : { reachable: false }) })));
   } else if (req.url === "/api/operation") {
    if (typeof value.operation !== "string" || !operations.has(value.operation)) throw new UiError("operation_not_allowed", "This operation is outside browser administration.");
    data = await engine.operations.execute(context, value.operation, value.input ?? {});
   } else throw new UiError("unknown_route", "Browser route is unavailable.");
   // Recheck revocation/expiry after potentially long OAuth, model, or retrieval work.
   await authorizeOwnerSession(store, brainId, origin, sessionId, csrf);
   json(res, { ok: true, data });
  } catch (error) {
   if (res.writableEnded || res.destroyed) return;
   const value = error as { code?: string; retryable?: boolean; suggestedFix?: string };
   res.statusCode = error instanceof OwnerSessionError ? 401 : value.code === "request_too_large" ? 413 : 400;
   json(res, { ok: false, error: { code: value.code ?? "operation_failed", message: error instanceof Error ? error.message : "Operation failed.", retryable: value.retryable === true, suggestedFix: value.suggestedFix ?? "Check the input and retry." } });
  } finally { active.delete(abort); completions.delete(completion); finish(); }
 });
 server.on("connection", (socket) => {
  if (closed) { socket.destroy(); return; }
  sockets.add(socket); socket.once("close", () => sockets.delete(socket));
 });
 server.requestTimeout = 360000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
 await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
 const address = server.address();
 if (!address || typeof address === "string") { server.close(); throw new Error("Browser listener did not return a port."); }
 origin = "http://127.0.0.1:" + address.port;
 return {
  origin,
  bootstrap() {
   if (closed) throw new UiError("ui_stopped", "Browser administration is stopped.");
   for (const [key, expiry] of tickets) if (expiry <= Date.now()) tickets.delete(key);
   while (tickets.size >= 16) tickets.delete(tickets.keys().next().value!);
   const ticket = randomBytes(32).toString("base64url"), expiry = Date.now() + 60000;
   tickets.set(digest(ticket), expiry);
   return { url: origin + "/#ticket=" + ticket, expiresAt: new Date(expiry).toISOString() };
  },
  close() { return closing ??= (async () => {
   closed = true; tickets.clear();
   for (const controller of active) controller.abort();
   await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); for (const socket of sockets) socket.destroy(); });
   await Promise.allSettled([...completions]);
  })(); },
 };
}
