import { createHash } from "node:crypto";
import { GoogleReadClient, GoogleApiError } from "./google-api";
import type { NormalizedDocument } from "./types";

type Common = { accountId: string; accountEmail: string; visibility: string[] };
export type GoogleBoundary = Common & (
 { service: "gmail"; labelIds: string[]; after: string; before: string; includeSpamTrash: boolean } |
 { service: "calendar"; calendarId: string; timeMin: string; timeMax: string } |
 { service: "contacts"; groupIds: string[]; allContacts: boolean }
);
export type GoogleCursor = { version: 1; boundaryHash: string; phase: "full" | "delta"; pageToken?: string; syncToken?: string; historyId?: string; baselineHistoryId?: string };
export type GooglePage = { documents: NormalizedDocument[]; next: GoogleCursor; complete: boolean; reconciled: boolean };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoogleApiError("invalid_response", 0, false); return value as Record<string, unknown>; };
const list = (value: unknown, maximum = 500): Record<string, unknown>[] => { if (value === undefined) return []; if (!Array.isArray(value) || value.length > maximum) throw new GoogleApiError("invalid_response", 0, false); return value.map(object); };
function text(value: unknown, maximum = 1024): string { if (typeof value !== "string" || !value || value.length > maximum) throw new GoogleApiError("invalid_response", 0, false); return value; }
function token(value: unknown): string | undefined { return value === undefined ? undefined : text(value, 8192); }
function dates(after: string, before: string) { if (typeof after !== "string" || typeof before !== "string" || !Number.isFinite(Date.parse(after)) || !Number.isFinite(Date.parse(before)) || Date.parse(before) <= Date.parse(after)) throw new Error("source boundary must have an increasing date interval"); }
export function validateGoogleBoundary(input: GoogleBoundary): GoogleBoundary {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("select an explicit Google source boundary");
 const fields: Record<string, string[]> = { gmail: ["labelIds", "after", "before", "includeSpamTrash"], calendar: ["calendarId", "timeMin", "timeMax"], contacts: ["groupIds", "allContacts"] };
 const allowed = new Set(["accountId", "accountEmail", "visibility", "service", ...(fields[input.service] ?? [])]);
 if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("unknown Google source boundary field");
 if (!/^[a-f0-9]{64}$/.test(input.accountId) || !/^[^\s@]+@[^\s@]+$/.test(input.accountEmail) || input.accountEmail.length > 254 || !Array.isArray(input.visibility) || !input.visibility.length || input.visibility.length > 32 || input.visibility.some((label) => typeof label !== "string" || !label.trim() || label.length > 128)) throw new Error("select an account and explicit private ingestion visibility");
 const identifiers = (values: string[], allowEmpty = false) => { if (!Array.isArray(values) || !allowEmpty && !values.length || values.length > 20 || values.some((value) => typeof value !== "string" || !value.trim() || value.length > 512)) throw new Error("select a bounded collection list"); };
 if (input.service === "gmail") { identifiers(input.labelIds); dates(input.after, input.before); if (typeof input.includeSpamTrash !== "boolean") throw new Error("select spam/trash ingestion explicitly"); }
 else if (input.service === "calendar") { identifiers([input.calendarId]); dates(input.timeMin, input.timeMax); }
 else if (input.service === "contacts") { identifiers(input.groupIds, input.allContacts === true); if (typeof input.allContacts !== "boolean" || input.allContacts && input.groupIds.length > 0) throw new Error("select contact groups or explicitly select all contacts"); }
 else throw new Error("unsupported Google source");
 return input;
}
export function googleBoundaryHash(input: GoogleBoundary) {
 const boundary = validateGoogleBoundary(input);
 const fields = Object.keys(boundary).sort().map((key) => { const value = (boundary as unknown as Record<string, unknown>)[key]; return [key, Array.isArray(value) ? [...value].sort() : value]; });
 return hash(JSON.stringify(fields));
}
export function googleSourceId(input: GoogleBoundary) { return "google:" + input.accountId + ":" + input.service + ":" + googleBoundaryHash(input).slice(0, 16); }
function document(boundary: GoogleBoundary, id: string, value: unknown, deleted: boolean, revision?: string, updatedAt?: string): NormalizedDocument {
 const content = deleted ? "" : JSON.stringify(value, null, 2) + "\n";
 if (content.length > 1000000) throw new GoogleApiError("document_too_large", 0, false);
 const root = boundary.service === "gmail" ? "email" : boundary.service === "calendar" ? "meetings" : "people";
 return { externalId: id, suggestedPath: root + "/google-" + boundary.accountId.slice(0, 16) + "/" + hash(googleSourceId(boundary) + ":" + id) + ".md", content, contentHash: hash(content), deleted, ...(revision ? { externalRevision: revision } : {}), ...(updatedAt && Number.isFinite(Date.parse(updatedAt)) ? { updatedAt } : {}), visibilityLabels: boundary.visibility, provenance: { sourceType: googleSourceId(boundary), sourcePath: "google:" + boundary.service + ":" + id, retrievedAt: new Date().toISOString(), metadata: { accountId: boundary.accountId, accountEmail: boundary.accountEmail, boundaryHash: googleBoundaryHash(boundary) } } };
}
function gmailBody(part: Record<string, unknown>, depth = 0): string {
 if (depth > 12) throw new GoogleApiError("message_nesting_too_deep", 0, false);
 if (["text/plain", "text/html"].includes(String(part.mimeType)) && part.body) {
  const body = object(part.body);
  if (typeof body.data === "string") { if (body.data.length > 1400000 || !/^[A-Za-z0-9_-]*={0,2}$/.test(body.data)) throw new GoogleApiError("invalid_message_body", 0, false); const contentType = list(part.headers, 1000).find((header) => String(header.name).toLowerCase() === "content-type");
   const charset = /charset=["']?([a-zA-Z0-9_-]{1,40})/i.exec(String(contentType?.value ?? ""))?.[1] ?? "utf-8";
   try { return new TextDecoder(charset, { fatal: true }).decode(Buffer.from(body.data, "base64url")); } catch { throw new GoogleApiError("unsupported_message_encoding", 0, false); } }
 }
 const parts = list(part.parts, 100), preferred = parts.filter((child) => child.mimeType === "text/plain");
 return (preferred.length ? preferred : parts).map((child) => gmailBody(child, depth + 1)).filter(Boolean).join("\n");
}
async function gmailMessage(client: GoogleReadClient, boundary: Extract<GoogleBoundary, { service: "gmail" }>, id: string, deleted = false) {
 let message: Record<string, unknown>;
 try { message = await client.get("gmail", "messages/" + encodeURIComponent(id), { format: "full" }); }
 catch (error) { if (error instanceof GoogleApiError && error.status === 404) { if (deleted) return document(boundary, id, null, true); throw new GoogleApiError("message_unavailable", 404, true, 1000); } throw error; }
 if (text(message.id) !== id) throw new GoogleApiError("message_identity_changed", 0, false);
 const labels = message.labelIds;
 if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) throw new GoogleApiError("invalid_response", 0, false);
 if (typeof message.internalDate !== "string" || !/^\d+$/.test(message.internalDate)) throw new GoogleApiError("invalid_message_timestamp", 0, false);
 const time = Number(message.internalDate);
 if (!Number.isFinite(time)) throw new GoogleApiError("invalid_message_timestamp", 0, false);
 const inBoundary = boundary.labelIds.every((label) => labels.includes(label)) && (boundary.includeSpamTrash || !labels.includes("SPAM") && !labels.includes("TRASH")) && time >= Date.parse(boundary.after) && time < Date.parse(boundary.before);
 if (!inBoundary) return document(boundary, id, null, true);
 const payload = object(message.payload), headers = list(payload.headers, 1000).filter((header) => ["from", "to", "cc", "subject", "date", "message-id"].includes(String(header.name).toLowerCase())).map((header) => ({ name: text(header.name, 128), value: typeof header.value === "string" && header.value.length <= 16384 ? header.value : (() => { throw new GoogleApiError("invalid_header", 0, false); })() }));
 return document(boundary, id, { id, threadId: message.threadId, labelIds: labels, headers, text: gmailBody(payload), snippet: typeof message.snippet === "string" ? message.snippet : "" }, false, token(message.historyId), new Date(time).toISOString());
}
async function gmailPage(client: GoogleReadClient, boundary: Extract<GoogleBoundary, { service: "gmail" }>, cursor: GoogleCursor): Promise<GooglePage> {
 let state = { ...cursor };
 if (state.phase === "full" && !state.baselineHistoryId) state.baselineHistoryId = text((await client.get("gmail", "profile")).historyId);
 const page = state.phase === "full" ? await client.get("gmail", "messages", { maxResults: "100", labelIds: boundary.labelIds, includeSpamTrash: String(boundary.includeSpamTrash), q: "after:" + (Math.floor(Date.parse(boundary.after) / 1000) - 1) + " before:" + (Math.ceil(Date.parse(boundary.before) / 1000) + 1), pageToken: state.pageToken }) : await client.get("gmail", "history", { startHistoryId: state.historyId, maxResults: "100", pageToken: state.pageToken });
 const ids = new Set<string>(), deleted = new Map<string, boolean>();
 if (state.phase === "full") for (const message of list(page.messages, 100)) ids.add(text(message.id));
 else for (const history of list(page.history, 100)) {
  for (const message of list(history.messages, 1000)) ids.add(text(message.id));
  for (const key of ["messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"]) for (const change of list(history[key], 1000)) {
   const id = text(object(change.message).id); ids.add(id);
   if (key === "messagesAdded") deleted.set(id, false);
   if (key === "messagesDeleted") deleted.set(id, !list(history.messagesAdded, 1000).some((item) => object(item.message).id === id));
  }
 }
 if (ids.size > 1000) throw new GoogleApiError("page_item_budget_exceeded", 0, false);
 const documents: NormalizedDocument[] = [];
 for (const id of ids) {
  try { documents.push(await gmailMessage(client, boundary, id, deleted.get(id) === true)); }
  catch (error) {
   if (!(error instanceof GoogleApiError) || error.code !== "message_unavailable" || state.phase !== "full") throw error;
   let pageToken: string | undefined, deletion: boolean | undefined;
   for (let attempt = 0; attempt < 10; attempt++) {
    let changes: Record<string, unknown>;
    try { changes = await client.get("gmail", "history", { startHistoryId: state.baselineHistoryId, maxResults: "100", pageToken }); }
    catch (failure) { if (failure instanceof GoogleApiError && failure.status === 404) throw new GoogleApiError("cursor_expired", 404, true); throw failure; }
    for (const history of list(changes.history, 100)) {
     if (list(history.messagesAdded, 1000).some((item) => object(item.message).id === id)) deletion = false;
     if (list(history.messagesDeleted, 1000).some((item) => object(item.message).id === id) && !list(history.messagesAdded, 1000).some((item) => object(item.message).id === id)) deletion = true;
    }
    pageToken = token(changes.nextPageToken);
    if (!pageToken) break;
   }
   if (pageToken || deletion !== true) throw error;
   documents.push(document(boundary, id, null, true));
  }
 }
 const nextPage = token(page.nextPageToken);
 const next: GoogleCursor = nextPage ? { ...state, pageToken: nextPage } : { version: 1, boundaryHash: state.boundaryHash, phase: "delta", historyId: state.phase === "full" ? state.baselineHistoryId! : text(page.historyId) };
 return { documents, next, complete: !nextPage, reconciled: false };
}
async function calendarPage(client: GoogleReadClient, boundary: Extract<GoogleBoundary, { service: "calendar" }>, state: GoogleCursor): Promise<GooglePage> {
 const page = await client.get("calendar", "calendars/" + encodeURIComponent(boundary.calendarId) + "/events", { maxResults: "200", showDeleted: "true", singleEvents: "false", timeMin: state.phase === "full" ? boundary.timeMin : undefined, timeMax: state.phase === "full" ? boundary.timeMax : undefined, syncToken: state.syncToken, pageToken: state.pageToken });
 const documents = list(page.items, 200).map((event) => {
  const id = text(event.id);
  if (event.status === "cancelled") return document(boundary, id, null, true, token(event.etag));
  const start = object(event.start), end = object(event.end), from = Date.parse(text(start.dateTime ?? start.date)), until = Date.parse(text(end.dateTime ?? end.date));
  if (!Number.isFinite(from) || !Number.isFinite(until)) throw new GoogleApiError("invalid_event_timestamp", 0, false);
  return document(boundary, id, event, until <= Date.parse(boundary.timeMin) || from >= Date.parse(boundary.timeMax), token(event.etag), token(event.updated));
 });
 const nextPage = token(page.nextPageToken);
 return { documents, next: nextPage ? { ...state, pageToken: nextPage } : { version: 1, boundaryHash: state.boundaryHash, phase: "delta", syncToken: text(page.nextSyncToken, 8192) }, complete: !nextPage, reconciled: false };
}
async function contactsPage(client: GoogleReadClient, boundary: Extract<GoogleBoundary, { service: "contacts" }>, state: GoogleCursor): Promise<GooglePage> {
 const page = await client.get("contacts", "people/me/connections", { pageSize: "200", personFields: "names,emailAddresses,phoneNumbers,organizations,memberships,metadata", sources: "READ_SOURCE_TYPE_CONTACT", requestSyncToken: "true", syncToken: state.syncToken, pageToken: state.pageToken });
 const documents = list(page.connections, 200).map((person) => {
  const id = text(person.resourceName), metadata = object(person.metadata ?? {});
  const groups = list(person.memberships, 100).map((membership) => membership.contactGroupMembership ? object(membership.contactGroupMembership).contactGroupResourceName : undefined);
  const deleted = metadata.deleted === true || !boundary.allContacts && !boundary.groupIds.some((group) => groups.includes(group));
  return document(boundary, id, person, deleted, token(person.etag));
 });
 const nextPage = token(page.nextPageToken);
 return { documents, next: nextPage ? { ...state, pageToken: nextPage } : { version: 1, boundaryHash: state.boundaryHash, phase: "delta", syncToken: text(page.nextSyncToken, 8192) }, complete: !nextPage, reconciled: false };
}
export async function readGooglePage(client: GoogleReadClient, boundary: GoogleBoundary, cursor?: GoogleCursor): Promise<GooglePage> {
 const boundaryHash = googleBoundaryHash(boundary);
 const initial: GoogleCursor = { version: 1, boundaryHash, phase: "full" };
 const state = cursor ?? initial;
 if (state.version !== 1 || state.boundaryHash !== boundaryHash || !["full", "delta"].includes(state.phase) || state.phase === "delta" && (boundary.service === "gmail" ? !state.historyId : !state.syncToken)) throw new Error("cursor does not match the selected ingestion boundary");
 const read = (current: GoogleCursor) => boundary.service === "gmail" ? gmailPage(client, boundary, current) : boundary.service === "calendar" ? calendarPage(client, boundary, current) : contactsPage(client, boundary, current);
 try { return await read(state); }
 catch (error) {
  const expired = error instanceof GoogleApiError && (error.code === "cursor_expired" || error.status === 410 || boundary.service === "gmail" && error.status === 404 && error.code === "http_404");
  if (!expired || state.phase !== "delta" && !(error instanceof GoogleApiError && error.code === "cursor_expired")) throw error;
  return { ...await read(initial), reconciled: true };
 }
}
