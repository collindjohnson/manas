import { createHash } from "node:crypto";
import type { BrainRepository, BrainSnapshot, BrainManifestEntry } from "./repository";
import type { BrainStore } from "./store";
import type { OperationContext } from "./operation-registry";
import { indexBrainRepository, searchVerifiedHybridBrainRepository, type Citation, type HybridProjectionSearchOptions } from "./pglite-indexer";
import { scopedSnapshot, recordVisible, isPrimaryEvidence, verifyEvidence } from "./evidence-contract";
import { listOpenLoops, getOpenLoop } from "./open-loops";
import { resolveEntity } from "./entity-relationships";
export const MEETING_PREPARATION_SOURCE = "manas-meeting-preparation";
export type MeetingInput = { idempotencyKey: string; meetingId?: string; title?: string; participants?: string[]; since?: string; maximumEvidence?: number };
type Evidence = { text: string; citation: Citation };
type Brief = { version: 1; principal: string; requestHash: string; createdAt: string; expiresAt: string; selectors: { meetingId?: string; title?: string; participants: string[]; since: string }; evidence: Evidence[]; participants: Array<{ query: string; entities: Array<{ id: string; revision: string }> }>; recentInteractions: Array<{ documentId: string; sourceUpdatedAt: string | null; evidence: number }>; openLoops: Array<{ id: string; revision: string; title: string; dueAt: string | null; evidence: number[] }>; gaps: string[] };
export class MeetingError extends Error {
 readonly retryable = false;
 constructor(readonly code: string, message: string, readonly suggestedFix = "Retrieve current authorized sources and prepare again with a new idempotency key.") { super(message); }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const principal = (context: OperationContext) => context.principal ?? "anonymous";
function inputError(message: string): never { throw new MeetingError("invalid_meeting_input", message); }
function wholeCitation(snapshot: BrainSnapshot, page: BrainManifestEntry, content: string): Citation {
 const end = Math.min(content.length, 8000), contentHash = hash(content.slice(0, end));
 return { tenantId: "local", brainId: snapshot.brainId, documentId: page.id, revision: page.revision, documentRevision: page.revision, commit: snapshot.commit, path: page.path, chunkId: page.id + ":" + contentHash + ":0:" + end, startOffset: 0, endOffset: end, contentHash, schemaPack: snapshot.settings.schemaPack };
}
async function readBrief(repository: BrainRepository, snapshot: BrainSnapshot, page: BrainManifestEntry) {
 const content = (await repository.readPage(snapshot, page.id)).content;
 if (Buffer.byteLength(content) > 524288) throw new MeetingError("invalid_meeting_record", "Meeting brief exceeds its size budget.");
 const brief = JSON.parse(content) as Brief;
 if (brief.version !== 1 || !Array.isArray(brief.evidence) || brief.evidence.length > 40 || !Array.isArray(brief.openLoops) || !Array.isArray(brief.participants)) throw new MeetingError("invalid_meeting_record", "Meeting brief is malformed.");
 return brief;
}
export async function getMeetingPreparation(repository: BrainRepository, context: OperationContext, id: string) {
 const snapshot = await scopedSnapshot(repository, context);
 const page = snapshot.pages.find((page) => page.id === id && page.source?.type === MEETING_PREPARATION_SOURCE && recordVisible(page, context));
 if (!page) throw new MeetingError("meeting_unavailable", "Meeting preparation is unavailable.");
 const brief = await readBrief(repository, snapshot, page);
 if (brief.principal !== principal(context) && !(context.scope === "admin" && context.allowedAccessLabels === undefined)) throw new MeetingError("meeting_unavailable", "Meeting preparation is unavailable.");
 let fresh = Date.parse(brief.expiresAt) > Date.now();
 const evidence: Evidence[] = [];
 const openLoops: Brief["openLoops"] = [];
 try {
  for (const item of brief.evidence) { const checked = await verifyEvidence(repository, snapshot, context, item.citation); evidence.push({ text: checked.text, citation: checked.citation }); }
  for (const loop of brief.openLoops) { const current = await getOpenLoop(repository, context, loop.id); if (current.revision !== loop.revision || current.status !== "open") fresh = false; openLoops.push({ id: current.id, revision: current.revision, title: current.title, dueAt: current.dueAt, evidence: loop.evidence }); }
  for (const participant of brief.participants) {
   const resolved = await resolveEntity(repository, context, participant.query);
   for (const entity of participant.entities) if (!resolved.entities.some((current) => current.id === entity.id && current.revision === entity.revision)) fresh = false;
  }
 } catch { fresh = false; }
 if (!fresh) return { id, revision: page.revision, freshness: "stale" as const, createdAt: brief.createdAt, expiresAt: brief.expiresAt };
 return { id, revision: page.revision, freshness: "current" as const, outcome: evidence.length ? "prepared" : "insufficient_evidence", createdAt: brief.createdAt, expiresAt: brief.expiresAt, selectors: brief.selectors, participants: brief.participants, recentInteractions: brief.recentInteractions, openLoops, evidence, gaps: brief.gaps };
}
export async function prepareMeeting(repository: BrainRepository, store: BrainStore, context: OperationContext, input: MeetingInput, searchOptions: HybridProjectionSearchOptions = {}, beforePersist?: () => Promise<void>) {
 if (!["admin", "write"].includes(context.scope)) throw new MeetingError("insufficient_scope", "Persisting a meeting preparation requires write authority.");
 if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 256) inputError("A bounded idempotency key is required.");
 if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.length > 500)) inputError("Meeting title must contain at most 500 characters.");
 if (input.participants !== undefined && (!Array.isArray(input.participants) || input.participants.length > 8 || input.participants.some((value) => typeof value !== "string" || !value.trim() || value.length > 128))) inputError("Provide at most eight bounded participant names or email addresses.");
 if (!input.meetingId && !input.title && !input.participants?.length) inputError("Supply a meeting document, title, or participants.");
 if (input.since !== undefined && !Number.isFinite(Date.parse(input.since))) inputError("since must be a timestamp.");
 const maximum = input.maximumEvidence ?? 12;
 if (!Number.isInteger(maximum) || maximum < 1 || maximum > 20) inputError("maximumEvidence must be between one and twenty.");
 const requestHash = hash(JSON.stringify([principal(context), input.meetingId ?? null, input.title ?? null, [...new Set(input.participants ?? [])].sort(), input.since ?? null, maximum]));
 let snapshot = await scopedSnapshot(repository, context);
 const externalId = hash(JSON.stringify([principal(context), input.idempotencyKey]));
 const old = snapshot.pages.find((page) => !page.deleted && page.source?.type === MEETING_PREPARATION_SOURCE && page.source.externalId === externalId);
 if (old) {
  if (!recordVisible(old, context)) throw new MeetingError("meeting_unavailable", "Meeting preparation is unavailable.");
  if ((await readBrief(repository, snapshot, old)).requestHash !== requestHash) throw new MeetingError("idempotency_conflict", "The idempotency key belongs to another meeting preparation.");
  return { ...await getMeetingPreparation(repository, context, old.id), replayed: true };
 }
 const since = input.since ? new Date(input.since).toISOString() : new Date(Date.now() - 90 * 86400000).toISOString();
 const evidence: Evidence[] = [], labels = new Set<string>(), gaps: string[] = [];
 const add = async (citation: Citation) => {
  const found = evidence.findIndex((item) => item.citation.documentId === citation.documentId && item.citation.startOffset === citation.startOffset && item.citation.endOffset === citation.endOffset);
  if (found >= 0) return found;
  if (evidence.length >= 40) throw new MeetingError("meeting_budget_exceeded", "Meeting evidence exceeds its forty span budget.");
  const checked = await verifyEvidence(repository, snapshot, context, citation);
  checked.labels.forEach((label) => labels.add(label));
  evidence.push({ text: checked.text, citation: checked.citation }); return evidence.length - 1;
 };
 let participants = [...new Set(input.participants ?? [])], title = input.title;
 if (input.meetingId) {
  const page = snapshot.pages.find((page) => page.id === input.meetingId && recordVisible(page, context) && isPrimaryEvidence(page));
  if (!page) throw new MeetingError("meeting_unavailable", "Meeting document is unavailable.");
  const content = (await repository.readPage(snapshot, page.id)).content;
  if (!content.length || content.length > 64000) inputError("Meeting document is empty or exceeds the preparation budget.");
  await add(wholeCitation(snapshot, page, content));
  try {
   const event = JSON.parse(content) as { summary?: unknown; attendees?: Array<{ displayName?: unknown; email?: unknown }> };
   if (!title && typeof event.summary === "string") title = event.summary.slice(0, 500);
   if (!participants.length && Array.isArray(event.attendees)) participants = event.attendees.map((person) => person.email ?? person.displayName).filter((value): value is string => typeof value === "string" && !!value.trim() && value.length <= 128).slice(0, 8);
  } catch { gaps.push("The meeting source is not a Calendar event; participant selectors must be supplied explicitly."); }
 }
 context.signal?.throwIfAborted();
 await indexBrainRepository(store, repository);
 snapshot = await scopedSnapshot(repository, context);
 const participantResults: Brief["participants"] = [];
 for (const query of participants) {
  context.signal?.throwIfAborted();
  const result = await resolveEntity(repository, context, query);
  result.entities.forEach((entity) => entity.visibility.forEach((label) => labels.add(label)));
  participantResults.push({ query, entities: result.entities.map((entity) => ({ id: entity.id, revision: entity.revision })) });
  if (!result.entities.length) gaps.push("No current entity match for participant selector: " + query);
 }
 const interactions: Brief["recentInteractions"] = [];
 for (const query of [...new Set([...participants, ...(title ? [title] : [])])].slice(0, 9)) {
  context.signal?.throwIfAborted();
  const results = await searchVerifiedHybridBrainRepository(store, repository, query, { ...searchOptions, brainId: snapshot.brainId, tenantId: context.tenantId ?? "local", allowedAccessLabels: context.allowedAccessLabels, limit: Math.min(maximum, 10) });
  for (const result of results) {
   if (interactions.length >= maximum) break;
   const page = snapshot.pages.find((page) => page.id === result.citation.documentId)!;
   if (!isPrimaryEvidence(page) || interactions.some((item) => item.documentId === page.id)) continue;
   const metadata = page.source?.provenance?.metadata ?? {};
   const at = page.source?.updatedAt ?? metadata.updated_at ?? metadata.created_at;
   if (at && Number.isFinite(Date.parse(at)) && Date.parse(at) < Date.parse(since)) continue;
   interactions.push({ documentId: page.id, sourceUpdatedAt: at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null, evidence: await add(result.citation) });
  }
 }
 const loops: Brief["openLoops"] = [];
 for (const participant of participants) {
  const current = await listOpenLoops(repository, context, { participant, status: "open", limit: 10 });
  for (const loop of current.items) {
   if (!("title" in loop) || loops.some((item) => item.id === loop.id) || loops.length >= 10) continue;
   const refs = [];
   for (const item of loop.evidence) refs.push(await add(item.citation));
   loops.push({ id: loop.id, revision: loop.revision, title: loop.title, dueAt: loop.dueAt, evidence: refs });
   loop.visibility.forEach((label) => labels.add(label));
  }
 }
 if (!interactions.length) gaps.push("No recent matching primary sources were retrieved.");
 if (interactions.some((item) => !item.sourceUpdatedAt)) gaps.push("Some matching sources lack timestamps; their recency is unknown.");
 if (!loops.length) gaps.push("No current open loops matched the supplied participants.");
 const now = new Date(), brief: Brief = { version: 1, principal: principal(context), requestHash, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString(), selectors: { meetingId: input.meetingId, title, participants, since }, evidence, participants: participantResults, recentInteractions: interactions, openLoops: loops, gaps };
 context.signal?.throwIfAborted();
 // Revalidate after retrieval and before committing; a changed head also rejects the write.
 snapshot = await scopedSnapshot(repository, context);
 for (const item of evidence) await verifyEvidence(repository, snapshot, context, item.citation);
 for (const loop of loops) if ((await getOpenLoop(repository, context, loop.id)).revision !== loop.revision) throw new MeetingError("meeting_evidence_changed", "A commitment changed during preparation.");
 await beforePersist?.();
 context.signal?.throwIfAborted();
 const result = await repository.putPage("notes/meeting-preparations/" + externalId + ".md", JSON.stringify(brief) + "\n", undefined, { type: MEETING_PREPARATION_SOURCE, externalId, visibilityLabels: [...labels].sort() }, snapshot.commit);
 return { ...await getMeetingPreparation(repository, context, result.id), replayed: false };
}
