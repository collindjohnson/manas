export class GoogleApiError extends Error {
 readonly suggestedFix: string;
 constructor(readonly code: string, readonly status: number, readonly retryable: boolean, readonly retryAfterMs = 0) {
  super("Google read-only API request failed (" + code + ").");
  this.suggestedFix = code === "existing_service_grants_required" ? "Reconnect with boundaries for every previously connected Google service so existing sources keep their grants." : status === 401 || status === 403 ? "Reconnect the selected Google account with the required read-only scopes." : retryable ? "Retry this checkpoint after the reported delay; do not advance the cursor." : "Inspect the selected source boundary and reconcile without deleting canonical history.";
 }
}
type TokenProvider = (forceRefresh?: boolean) => Promise<string>;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export class GoogleReadClient {
 constructor(private readonly token: TokenProvider, private readonly fetcher: Fetcher = fetch) {}
 async get(service: "gmail" | "calendar" | "contacts", resource: string, parameters: Record<string, string | string[] | undefined> = {}): Promise<Record<string, unknown>> {
  const base = { gmail: "https://gmail.googleapis.com/gmail/v1/users/me/", calendar: "https://www.googleapis.com/calendar/v3/", contacts: "https://people.googleapis.com/v1/" }[service];
  const valid = service === "gmail" ? /^(profile|labels|history|messages|messages\/[a-zA-Z0-9_-]+)$/.test(resource) : service === "calendar" ? /^(users\/me\/calendarList|calendars\/[^/]+\/events)$/.test(resource) : /^(people\/me\/connections|contactGroups)$/.test(resource);
  if (!valid || resource.includes("..") || resource.includes("?") || resource.includes("#")) throw new GoogleApiError("invalid_resource", 0, false);
  const url = new URL(base + resource);
  for (const [key, values] of Object.entries(parameters)) for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) { if (value.length > 8192) throw new GoogleApiError("invalid_parameter", 0, false); url.searchParams.append(key, value); }
  for (let attempt = 0; attempt < 2; attempt++) {
   let token: string;
   try { token = await this.token(attempt > 0); } catch (error) { if (error instanceof GoogleApiError) throw error; throw new GoogleApiError("credentials_unavailable", 401, false); }
   if (!token || /[\r\n]/.test(token)) throw new GoogleApiError("credentials_unavailable", 401, false);
   let response: Response;
   try { response = await this.fetcher(url.href, { method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20000) }); }
   catch { throw new GoogleApiError("network_unavailable", 0, true, 1000); }
   if (response.status === 401 && attempt === 0) { await response.body?.cancel(); continue; }
   if (!response.ok) {
    let code = "http_" + response.status;
    if (response.status === 400) {
     try {
      const parts: Uint8Array[] = [], reader = response.body?.getReader();
      let size = 0;
      if (reader) try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 16384) break; parts.push(part.value); } } finally { await reader.cancel(); }
      const body = Buffer.concat(parts).toString("utf8");
      if (size <= 16384) {
       const failure = JSON.parse(body);
       if (Array.isArray(failure?.error?.details) && failure.error.details.some((detail: { reason?: unknown }) => detail.reason === "EXPIRED_SYNC_TOKEN")) code = "cursor_expired";
      }
     } catch {}
    } else await response.body?.cancel();
    const delay = Number(response.headers.get("retry-after"));
    throw new GoogleApiError(code, response.status, response.status === 429 || response.status >= 500, Number.isFinite(delay) && delay > 0 ? Math.min(60000, delay * 1000) : 1000);
   }
   if (response.redirected) throw new GoogleApiError("unexpected_redirect", 0, false);
   const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
   let size = 0;
   try {
    if (reader) while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 8 * 1024 * 1024) throw new GoogleApiError("response_too_large", 0, false); chunks.push(part.value); }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
    return value;
   } catch (error) { await reader?.cancel().catch(() => {}); if (error instanceof GoogleApiError) throw error; throw new GoogleApiError("invalid_response", 0, false); }
  }
  throw new GoogleApiError("credentials_unavailable", 401, false);
 }
}
