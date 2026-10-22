import { test, expect } from "bun:test";
import { GoogleReadClient, GoogleApiError } from "../src/sources/google-api";
import { readGooglePage, googleBoundaryHash, type GoogleBoundary } from "../src/sources/google-pages";
import { syncGooglePage } from "../src/brain/google-sync";
import { openPgliteBrainStore } from "../src/brain/store";
import { BrainRepository } from "../src/brain/repository";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const common = { accountId: "a".repeat(64), accountEmail: "owner@example.invalid", visibility: ["personal"] };
const calendar: GoogleBoundary = { ...common, service: "calendar", calendarId: "selected@example.invalid", timeMin: "2026-01-01T00:00:00Z", timeMax: "2027-01-01T00:00:00Z" };
const event = (id: string) => ({ id, etag: "revision-" + id, summary: id, start: { dateTime: "2026-10-21T10:00:00Z" }, end: { dateTime: "2026-10-21T11:00:00Z" }, updated: "2026-10-20T00:00:00Z" });
test("read-only Google transport bounds resources, refreshes once, and redacts server failures", async () => {
 const refreshes: boolean[] = [];
 let calls = 0;
 const client = new GoogleReadClient(async (force) => { refreshes.push(Boolean(force)); return "private-token"; }, async (url, init) => {
  expect(url).toStartWith("https://gmail.googleapis.com/");
  expect(init.method).toBe("GET"); expect(init.redirect).toBe("error");
  expect(init.headers).toMatchObject({ Authorization: "Bearer private-token" });
  return ++calls === 1 ? new Response("secret-server-error", { status: 401 }) : Response.json({ historyId: "10" });
 });
 expect(await client.get("gmail", "profile")).toEqual({ historyId: "10" });
 expect(refreshes).toEqual([false, true]);
 await expect(client.get("gmail", "../messages/send")).rejects.toThrow("invalid_resource");
 const failed = new GoogleReadClient(async () => "token", async () => new Response("private source content", { status: 429, headers: { "retry-after": "5" } }));
 try { await failed.get("contacts", "people/me/connections"); throw new Error("expected failure"); }
 catch (error) { expect(error).toBeInstanceOf(GoogleApiError); expect(error).toMatchObject({ retryable: true, retryAfterMs: 5000 }); expect(String(error)).not.toContain("private source"); }
});
test("Calendar and Contacts paginate with stable parameters and reconcile expired sync tokens", async () => {
 const requests: URL[] = [];
 const client = new GoogleReadClient(async () => "token", async (url) => {
  const parsed = new URL(url); requests.push(parsed);
  if (parsed.searchParams.get("syncToken") === "expired") return new Response("", { status: 410 });
  return parsed.searchParams.has("pageToken") ? Response.json({ items: [event("second")], nextSyncToken: "new-token" }) : Response.json({ items: [event("first")], nextPageToken: "page-two" });
 });
 const first = await readGooglePage(client, calendar);
 expect(first.complete).toBe(false);
 const second = await readGooglePage(client, calendar, first.next);
 expect(second.next.syncToken).toBe("new-token");
 expect(requests[1]!.searchParams.get("timeMin")).toBe(calendar.timeMin);
 const recovered = await readGooglePage(client, calendar, { version: 1, boundaryHash: googleBoundaryHash(calendar), phase: "delta", syncToken: "expired" });
 expect(recovered.reconciled).toBe(true);
 expect(requests[2]!.searchParams.has("timeMin")).toBe(false);
 const contacts: GoogleBoundary = { ...common, service: "contacts", groupIds: ["contactGroups/selected"], allContacts: false };
 const people = new GoogleReadClient(async () => "token", async (url) => {
  const query = new URL(url).searchParams;
  expect(query.get("personFields")).toContain("memberships");
  expect(query.get("sources")).toBe("READ_SOURCE_TYPE_CONTACT");
  return Response.json({ connections: [{ resourceName: "people/one", etag: "one", metadata: {}, memberships: [{ contactGroupMembership: { contactGroupResourceName: "contactGroups/selected" } }], names: [{ displayName: "Maya" }] }, { resourceName: "people/other", metadata: {}, memberships: [] }], nextSyncToken: "people-token" });
 });
 const page = await readGooglePage(people, contacts);
 expect(page.documents.map((document) => [document.externalId, document.deleted])).toEqual([["people/one", false], ["people/other", true]]);
 expect(page.next.syncToken).toBe("people-token");
});
test("Gmail starts history before a full scan and reconciles changes with current label and date boundaries", async () => {
 const boundary: GoogleBoundary = { ...common, service: "gmail", labelIds: ["INBOX"], after: "2026-01-01T00:00:00Z", before: "2027-01-01T00:00:00Z", includeSpamTrash: false };
 const order: string[] = [];
 const client = new GoogleReadClient(async () => "token", async (url) => {
  const parsed = new URL(url), path = parsed.pathname; order.push(path.split("/").at(-1)!);
  if (path.endsWith("/profile")) return Response.json({ historyId: "100" });
  if (path.endsWith("/history")) return Response.json({ historyId: "120", history: [{ id: "110", messagesAdded: [{ message: { id: "new" } }], labelsRemoved: [{ message: { id: "old" } }] }] });
  if (path.endsWith("/messages")) { expect(parsed.searchParams.getAll("labelIds")).toEqual(["INBOX"]); return Response.json({ messages: [{ id: "old" }] }); }
  const id = path.split("/").at(-1)!;
  return Response.json({ id, historyId: "105", internalDate: String(Date.parse("2026-10-21T00:00:00Z")), labelIds: id === "old" && order.filter((value) => value === "old").length > 1 ? [] : ["INBOX"], payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Selected message" }], body: { data: Buffer.from("Evidence-backed mail").toString("base64url") } } });
 });
 const full = await readGooglePage(client, boundary);
 expect(order.slice(0, 2)).toEqual(["profile", "messages"]);
 expect(full.next.historyId).toBe("100");
 expect(full.documents[0]!.content).toContain("Evidence-backed mail");
 const delta = await readGooglePage(client, boundary, full.next);
 expect(delta.next.historyId).toBe("120");
 expect(delta.documents.map((document) => [document.externalId, document.deleted])).toEqual([["new", false], ["old", true]]);
});
test("Google page journal replays a commit/checkpoint crash and reconciles omissions without deleting history", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-google-sync-"));
 const store = await openPgliteBrainStore(join(root, "state")), repository = new BrainRepository(join(root, "brain"));
 try {
  await repository.initialize();
  const run = promisify(execFile);
  await run("git", ["-C", repository.root, "config", "user.name", "Test"]);
  await run("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  let requests = 0, fail = true, reconcile = false;
  const client = new GoogleReadClient(async () => "token", async (url) => {
   requests++;
   if (new URL(url).searchParams.has("syncToken")) return reconcile ? new Response("", { status: 410 }) : Response.json({ items: [], nextSyncToken: "same-token" });
   return Response.json({ items: reconcile ? [] : [event("meeting")], nextSyncToken: "same-token" });
  });
  const options = { store, repository, client, boundary: calendar, workerId: "worker" };
  await expect(syncGooglePage({ ...options, faultInjector: async (point) => { if (point === "after-git-write" && fail) { fail = false; throw new Error("injected crash"); } } })).rejects.toThrow("injected crash");
  const committed = await repository.head();
  expect((await store.query<{ cursor: unknown }>("SELECT cursor FROM brain_google_sources"))[0]!.cursor).toBeNull();
  const success = await syncGooglePage(options);
  expect(success.complete).toBe(true);
  expect(requests).toBe(1);
  expect(await repository.head()).toBe(committed);
  expect(await store.query("SELECT error_code FROM brain_google_attempts")).toMatchObject([{ error_code: "persistence_failed" }]);
  await syncGooglePage(options);
  await syncGooglePage(options);
  expect(requests).toBe(3); // A repeated unchanged sync token must not pin the journal to an old batch.
  reconcile = true;
  const recovered = await syncGooglePage(options);
  expect(recovered.reconciled).toBe(true);
  const pages = await repository.listPages();
  expect(pages).toHaveLength(1);
  expect(pages[0]!.stale).toBe(true);
  expect((await repository.readPage(await repository.snapshot(committed), pages[0]!.id)).content).toContain("meeting");
  expect((await store.query<{ count: number }>("SELECT count(*)::int AS count FROM brain_jobs WHERE type='projection'"))[0]!.count).toBe(4);
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);

test("Google boundaries reject unrecognized fields and foreign cursors", async () => {
 const client = new GoogleReadClient(async () => "token", async () => { throw new Error("must not fetch"); });
 await expect(readGooglePage(client, { ...calendar, accessToken: "do-not-store" } as GoogleBoundary)).rejects.toThrow("unknown Google source boundary field");
 await expect(readGooglePage(client, calendar, { version: 1, boundaryHash: "foreign", phase: "delta", syncToken: "token" })).rejects.toThrow("cursor does not match");
});
test("Contacts recover the documented expired-sync error without retaining the expired token", async () => {
 const boundary: GoogleBoundary = { ...common, service: "contacts", groupIds: [], allContacts: true };
 const requests: URL[] = [];
 const client = new GoogleReadClient(async () => "token", async (url) => {
  const parsed = new URL(url); requests.push(parsed);
  return parsed.searchParams.has("syncToken") ? Response.json({ error: { details: [{ reason: "EXPIRED_SYNC_TOKEN" }] } }, { status: 400 }) : Response.json({ connections: [], nextSyncToken: "replacement" });
 });
 const page = await readGooglePage(client, boundary, { version: 1, boundaryHash: googleBoundaryHash(boundary), phase: "delta", syncToken: "expired" });
 expect(page.reconciled).toBe(true);
 expect(page.next.syncToken).toBe("replacement");
 expect(requests[1]!.searchParams.has("syncToken")).toBe(false);
});
test("Gmail requires deletion evidence for unavailable messages and preserves a retryable cursor", async () => {
 const boundary: GoogleBoundary = { ...common, service: "gmail", labelIds: ["INBOX"], after: "2026-01-01T00:00:00Z", before: "2027-01-01T00:00:00Z", includeSpamTrash: false };
 let confirmed = false, profiles = 0;
 const client = new GoogleReadClient(async () => "token", async (url) => {
  const path = new URL(url).pathname;
  if (path.endsWith("/profile")) { profiles++; return Response.json({ historyId: "100" }); }
  if (path.endsWith("/messages")) return Response.json({ messages: [{ id: "gone" }] });
  if (path.endsWith("/history")) return Response.json({ historyId: "110", history: confirmed ? [{ messagesDeleted: [{ message: { id: "gone" } }] }] : [{ messages: [{ id: "gone" }] }] });
  return new Response("", { status: 404 });
 });
 await expect(readGooglePage(client, boundary)).rejects.toMatchObject({ code: "message_unavailable", retryable: true });
 confirmed = true;
 const page = await readGooglePage(client, boundary);
 expect(page.documents).toHaveLength(1);
 expect(page.documents[0]!.deleted).toBe(true);
 expect(page.next.historyId).toBe("100");
 confirmed = false;
 await expect(readGooglePage(client, boundary, page.next)).rejects.toMatchObject({ code: "message_unavailable", retryable: true });
 expect(profiles).toBe(2); // A message 404 must never trigger history reconciliation.
});

test("Google pagination checkpoints only persisted pages and fences concurrent workers with the same name", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-google-pages-"));
 const store = await openPgliteBrainStore(join(root, "state")), repository = new BrainRepository(join(root, "brain"));
 try {
  await repository.initialize();
  const run = promisify(execFile);
  await run("git", ["-C", repository.root, "config", "user.name", "Test"]);
  await run("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  let fail = true, held = false;
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const client = new GoogleReadClient(async () => "token", async (url) => {
   const query = new URL(url).searchParams;
   if (!query.has("pageToken")) return Response.json({ items: [event("first")], nextPageToken: "second-page" });
   if (fail) return new Response("", { status: 503 });
   if (held) { entered(); await blocked; }
   return Response.json({ items: [event("late")], nextSyncToken: "finished" });
  });
  const options = { store, repository, client, boundary: calendar, workerId: "same-worker-name" };
  expect((await syncGooglePage(options)).complete).toBe(false);
  await expect(syncGooglePage(options)).rejects.toMatchObject({ code: "http_503", retryable: true });
  const checkpoint = (await store.query<{ cursor: { pageToken: string } }>("SELECT cursor FROM brain_google_sources"))[0]!.cursor;
  expect(checkpoint.pageToken).toBe("second-page");
  expect(await repository.listPages()).toHaveLength(1);
  fail = false; held = true;
  const active = syncGooglePage(options);
  await waiting;
  try { await expect(syncGooglePage(options)).rejects.toMatchObject({ code: "google_source_busy" }); }
  finally { release(); }
  expect((await active).complete).toBe(true);
  expect(await repository.listPages()).toHaveLength(2);
  expect((await store.query<{ cursor: { syncToken: string } }>("SELECT cursor FROM brain_google_sources"))[0]!.cursor.syncToken).toBe("finished");
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);

test("Google persistence rechecks authorization after fetch before committing evidence or advancing cursors", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-google-revocation-"));
 const store = await openPgliteBrainStore(join(root, "state")), repository = new BrainRepository(join(root, "brain"));
 try {
  await repository.initialize();
  const run = promisify(execFile);
  await run("git", ["-C", repository.root, "config", "user.name", "Test"]);
  await run("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  let enabled = true;
  const client = new GoogleReadClient(async () => "token", async () => Response.json({ items: [event("restricted")], nextSyncToken: "next" }));
  await expect(syncGooglePage({ store, repository, client, boundary: calendar, workerId: "worker",
   assertAccess: async () => { if (!enabled) throw new GoogleApiError("source_revoked", 403, false); },
   faultInjector: async (point) => { if (point === "after-fetch") enabled = false; },
  })).rejects.toMatchObject({ code: "source_revoked" });
  expect(await repository.listPages()).toHaveLength(0);
  expect((await store.query<{ cursor: unknown }>("SELECT cursor FROM brain_google_sources"))[0]!.cursor).toBeNull();
  expect(await store.query("SELECT error_code,retryable FROM brain_google_attempts")).toMatchObject([{ error_code: "source_revoked", retryable: false }]);
 } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);
