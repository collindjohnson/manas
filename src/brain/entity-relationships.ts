import { createHash } from "node:crypto";
import type { BrainRepository, BrainSnapshot, BrainManifestEntry } from "./repository";
import type { OperationContext } from "./operation-registry";
import type { Citation } from "./pglite-indexer";
import { scopedSnapshot, recordVisible, verifyEvidence, EvidenceError } from "./evidence-contract";

export const ENTITY_SOURCE = "manas-entity", RELATION_SOURCE = "manas-relationship", REVIEW_SOURCE = "manas-entity-review";
type Base = { version: 1; evidence: Citation[]; confidence: number; validFrom?: string; validUntil?: string };
export type EntityDefinition = Base & { name: string; entityType: string; aliases: string[]; mergedInto?: string; mergeReviewId?: string };
export type RelationshipDefinition = Base & { fromId: string; toId: string; relationshipType: string };
type Entity = EntityDefinition & { id: string; revision: string; visibility: string[] };
type Relationship = RelationshipDefinition & { id: string; revision: string; visibility: string[]; redirects?: Array<{ id: string; revision: string; targetId: string; reviewId?: string; evidence: Citation[] }> };
type Write = { id?: string; expectedRevision?: string; idempotencyKey: string; visibility?: string[] };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const normalized = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
function bounded(value: unknown, maximum = 128): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error("invalid bounded graph input"); }
function canonical(value: unknown): string {
 if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
 if (value && typeof value === "object") return "{" + Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
 return JSON.stringify(value);
}
function active(value: Base, at = Date.now()) { return (!value.validFrom || Date.parse(value.validFrom) <= at) && (!value.validUntil || Date.parse(value.validUntil) > at); }
function base(input: Omit<Base, "version">): Base {
 if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 10 || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error("graph assertions need one to ten citations and confidence between zero and one");
 const dates: { validFrom?: string; validUntil?: string } = {};
 for (const name of ["validFrom", "validUntil"] as const) {
  if (input[name] !== undefined) { if (typeof input[name] !== "string" || !Number.isFinite(Date.parse(input[name]!))) throw new Error("invalid graph validity"); dates[name] = new Date(input[name]!).toISOString(); }
 }
 if (dates.validFrom && dates.validUntil && dates.validUntil <= dates.validFrom) throw new Error("graph validity must end after it starts");
 return { version: 1, evidence: input.evidence, confidence: input.confidence, ...dates };
}
async function verified(repository: BrainRepository, snapshot: BrainSnapshot, context: OperationContext, input: Omit<Base, "version">) {
 const value = base(input), citations: Citation[] = [], labels = new Set<string>();
 for (const citation of value.evidence) {
  const evidence = await verifyEvidence(repository, snapshot, context, citation);
  citations.push(evidence.citation); for (const label of evidence.labels) labels.add(label);
 }
 return { ...value, evidence: citations, labels: [...labels].sort() };
}
async function definition<T>(repository: BrainRepository, snapshot: BrainSnapshot, page: BrainManifestEntry): Promise<T> {
 const content = (await repository.readPage(snapshot, page.id)).content;
 if (content.length > 65536) throw new Error("graph record exceeds the size budget");
 const parsed = JSON.parse(content);
 if (!parsed || parsed.version !== 1 || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid graph record");
 return parsed as T;
}
async function records(repository: BrainRepository, snapshot: BrainSnapshot, context: OperationContext) {
 const pages = snapshot.pages.filter((page) => [ENTITY_SOURCE, RELATION_SOURCE].includes(page.source?.type ?? "") && recordVisible(page, context));
 if (pages.length > 2000) throw new Error("graph scan exceeds the 2000 record budget");
 const entities: Entity[] = [], relationships: Relationship[] = [];
 for (const page of pages.sort((a, b) => a.id.localeCompare(b.id))) {
  try {
   const input = await definition<EntityDefinition & RelationshipDefinition>(repository, snapshot, page);
   if (!active(input)) continue;
   const checked = await verified(repository, snapshot, context, input);
   const common = { ...input, evidence: checked.evidence, id: page.id, revision: page.revision, visibility: page.accessLabels ?? [] };
   if (page.source?.type === ENTITY_SOURCE) { bounded(input.name); bounded(input.entityType); if (!Array.isArray(input.aliases) || input.aliases.length > 20) continue; input.aliases.forEach((alias) => bounded(alias)); entities.push(common); }
   else { bounded(input.fromId, 256); bounded(input.toId, 256); bounded(input.relationshipType); relationships.push(common); }
  } catch (error) { if (!(error instanceof EvidenceError)) throw error; /* Suppress withdrawn, invalid, or inaccessible assertions. */ }
 }
 const byId = new Map(entities.map((entity) => [entity.id, entity]));
 const canonicalId = (id: string) => {
  const visited = new Set<string>();
  for (let depth = 0; depth < 20; depth++) {
   const entity = byId.get(id);
   if (!entity || visited.has(id)) return undefined;
   if (!entity.mergedInto) return id;
   visited.add(id); id = entity.mergedInto;
  }
  return undefined;
 };
 const redirects = new Map(entities.filter((entity) => entity.mergedInto).flatMap((entity) => { const id = canonicalId(entity.id); return id ? [[entity.id, id] as const] : []; }));
 const redirectChain = (id: string) => {
  const result: NonNullable<Relationship["redirects"]> = [];
  for (let depth = 0; depth < 20; depth++) {
   const entity = byId.get(id);
   if (!entity?.mergedInto) break;
   result.push({ id: entity.id, revision: entity.revision, targetId: entity.mergedInto, ...(entity.mergeReviewId ? { reviewId: entity.mergeReviewId } : {}), evidence: entity.evidence });
   id = entity.mergedInto;
  }
  return result;
 };
 return { entities: entities.filter((entity) => !entity.mergedInto), redirects, relationships: relationships.flatMap((edge) => {
  const fromId = canonicalId(edge.fromId), toId = canonicalId(edge.toId);
  const lineage = [...redirectChain(edge.fromId), ...redirectChain(edge.toId)];
  return fromId && toId && fromId !== toId ? [{ ...edge, fromId, toId, ...(lineage.length ? { redirects: lineage } : {}) }] : [];
 }) };
}
async function writeRecord(repository: BrainRepository, snapshot: BrainSnapshot, context: OperationContext, sourceType: string, input: Write, value: Record<string, unknown>, labels: string[]) {
 bounded(input.idempotencyKey, 256);
 const visibility = [...new Set(input.visibility ?? labels)].sort();
 if (visibility.length > 32 || visibility.some((label) => typeof label !== "string" || !label.trim() || label.length > 128) || labels.some((label) => !visibility.includes(label)) || context.allowedAccessLabels && visibility.some((label) => !context.allowedAccessLabels!.includes(label))) throw new EvidenceError();
 const requestHash = hash(canonical({ input, value, visibility })), receiptKey = "graph.receipt." + hash(input.idempotencyKey);
 for (const page of snapshot.pages.filter((page) => page.source?.type === sourceType)) {
  const stored = page.source?.provenance?.metadata?.[receiptKey];
  if (!stored) continue;
  if (!recordVisible(page, context)) throw new EvidenceError();
  const receipt = JSON.parse(stored) as { requestHash: string; revision: string };
  if (receipt.requestHash !== requestHash) throw new Error("graph idempotency conflict");
  return { id: page.id, revision: receipt.revision, currentRevision: page.revision, replayed: true };
 }
 const old = input.id ? snapshot.pages.find((page) => page.id === input.id && page.source?.type === sourceType && recordVisible(page, context)) : undefined;
 if (input.id && !old) throw new EvidenceError();
 if (old && old.revision !== input.expectedRevision || !old && input.expectedRevision !== undefined) throw new Error("stale graph revision");
 const content = JSON.stringify(value, null, 2) + "\n", revision = hash(content);
 const metadata = { ...old?.source?.provenance?.metadata, [receiptKey]: JSON.stringify({ requestHash, revision }) };
 if (Object.keys(metadata).length > 512) throw new Error("graph revision receipt budget exceeded");
 const path = old?.path ?? "notes/graph/" + sourceType + "-" + hash(input.idempotencyKey) + ".md";
 const result = await repository.putPage(path, content, old?.revision, { type: sourceType, externalId: old?.source?.externalId ?? hash(input.idempotencyKey), visibilityLabels: visibility, provenance: { sourceType, retrievedAt: new Date().toISOString(), metadata } }, snapshot.commit);
 return { id: result.id, revision: result.revision, currentRevision: result.revision, replayed: false };
}
export async function putEntity(repository: BrainRepository, context: OperationContext, input: Write & Omit<EntityDefinition, "version" | "mergedInto" | "mergeReviewId">) {
 bounded(input.idempotencyKey, 256);
 const snapshot = await scopedSnapshot(repository, context);
 bounded(input.name); bounded(input.entityType);
 if (!Array.isArray(input.aliases) || input.aliases.length > 20) throw new Error("aliases must be a bounded list");
 input.aliases.forEach((alias) => bounded(alias));
 const checked = await verified(repository, snapshot, context, input);
 const aliases = [...new Set(input.aliases.map((alias) => alias.trim()))].sort();
 const value: EntityDefinition = { version: 1, name: input.name.trim(), entityType: input.entityType.trim(), aliases, evidence: checked.evidence, confidence: checked.confidence, ...(checked.validFrom ? { validFrom: checked.validFrom } : {}), ...(checked.validUntil ? { validUntil: checked.validUntil } : {}) };
 if (snapshot.pages.some((page) => page.source?.type === ENTITY_SOURCE && page.source.provenance?.metadata?.["graph.receipt." + hash(input.idempotencyKey)])) return { needsReview: false as const, ...await writeRecord(repository, snapshot, context, ENTITY_SOURCE, input, value, checked.labels) };
 const priorReview = snapshot.pages.find((page) => page.source?.type === REVIEW_SOURCE && page.source.provenance?.metadata?.["graph.receipt." + hash(input.idempotencyKey)]);
 if (priorReview) {
  if (!recordVisible(priorReview, context)) throw new EvidenceError();
  const previous = await definition<EntityReview & { proposalRequestHash?: string }>(repository, snapshot, priorReview);
  if (previous.proposalRequestHash !== hash(canonical(input))) throw new Error("graph idempotency conflict");
  const receipt = JSON.parse(priorReview.source!.provenance!.metadata!["graph.receipt." + hash(input.idempotencyKey)]!) as { revision: string };
  return { needsReview: true as const, review: { id: priorReview.id, revision: receipt.revision, currentRevision: priorReview.revision, replayed: true } };
 }
 if (input.id) {
  const current = snapshot.pages.find((page) => page.id === input.id && page.source?.type === ENTITY_SOURCE && recordVisible(page, context));
  if (!current || current.revision !== input.expectedRevision) throw new EntityReviewError("stale_entity", "Entity revision changed.");
  if ((await definition<EntityDefinition>(repository, snapshot, current)).mergedInto) throw new EntityReviewError("merged_entity", "A merged entity is retained as a redirect; update its canonical target.");
 }
 const graph = await records(repository, snapshot, context);
 const keys = new Set([value.name, ...aliases].map(normalized));
 const collisions = graph.entities.filter((entity) => entity.id !== input.id && !snapshot.pages.find((page) => page.id === entity.id)?.source?.provenance?.metadata?.["graph.receipt." + hash(input.idempotencyKey)] && [entity.name, ...entity.aliases].some((alias) => keys.has(normalized(alias))));
 if (collisions.length) {
  const labels = [...new Set([...checked.labels, ...(input.visibility ?? []), ...collisions.flatMap((entity) => entity.visibility), ...(input.id ? snapshot.pages.find((page) => page.id === input.id)?.accessLabels ?? [] : [])])].sort();
  const review = await writeRecord(repository, snapshot, context, REVIEW_SOURCE, { idempotencyKey: input.idempotencyKey, visibility: labels }, { version: 1, status: "pending", action: "entity-merge", proposalRequestHash: hash(canonical(input)), proposed: value, candidates: collisions.map((entity) => ({ id: entity.id, revision: entity.revision })), ...(input.id ? { originalEntity: { id: input.id, revision: input.expectedRevision } } : {}) }, labels);
  return { needsReview: true as const, review };
 }
 return { needsReview: false as const, ...await writeRecord(repository, snapshot, context, ENTITY_SOURCE, input, value, checked.labels) };
}
export async function putRelationship(repository: BrainRepository, context: OperationContext, input: Write & Omit<RelationshipDefinition, "version">) {
 const snapshot = await scopedSnapshot(repository, context);
 bounded(input.fromId, 256); bounded(input.toId, 256); bounded(input.relationshipType);
 const checked = await verified(repository, snapshot, context, input), graph = await records(repository, snapshot, context);
 const from = graph.entities.find((entity) => entity.id === input.fromId), to = graph.entities.find((entity) => entity.id === input.toId);
 if (!from || !to) throw new EvidenceError();
 const labels = [...new Set([...checked.labels, ...from.visibility, ...to.visibility])].sort();
 const value: RelationshipDefinition = { version: 1, fromId: from.id, toId: to.id, relationshipType: input.relationshipType.trim(), evidence: checked.evidence, confidence: checked.confidence, ...(checked.validFrom ? { validFrom: checked.validFrom } : {}), ...(checked.validUntil ? { validUntil: checked.validUntil } : {}) };
 return writeRecord(repository, snapshot, context, RELATION_SOURCE, input, value, labels);
}
export async function resolveEntity(repository: BrainRepository, context: OperationContext, query: string) {
 bounded(query);
 const graph = await records(repository, await scopedSnapshot(repository, context), context);
 const entities = graph.entities.filter((entity) => entity.id === query || entity.id === graph.redirects.get(query) || [entity.name, ...entity.aliases].some((alias) => normalized(alias) === normalized(query)));
 return { entities, needsReview: entities.length > 1 };
}
export async function queryRelationships(repository: BrainRepository, context: OperationContext, input: { from: string; to?: string; maximumDepth?: number; maximumResults?: number; direction?: "outbound" | "inbound" | "both"; relationshipTypes?: string[] }) {
 bounded(input.from); if (input.to !== undefined) bounded(input.to);
 const depth = input.maximumDepth ?? 3, limit = input.maximumResults ?? 50, direction = input.direction ?? "outbound";
 if (!["outbound", "inbound", "both"].includes(direction) || !Number.isInteger(depth) || depth < 1 || depth > 3 || !Number.isInteger(limit) || limit < 1 || limit > 100 || input.relationshipTypes && (!Array.isArray(input.relationshipTypes) || input.relationshipTypes.length > 10)) throw new Error("invalid bounded relationship plan");
 input.relationshipTypes?.forEach((type) => bounded(type));
 const graph = await records(repository, await scopedSnapshot(repository, context), context);
 const matches = (query: string) => graph.entities.filter((entity) => entity.id === query || entity.id === graph.redirects.get(query) || [entity.name, ...entity.aliases].some((alias) => normalized(alias) === normalized(query)));
 const starts = matches(input.from), targets = input.to ? matches(input.to) : undefined;
 if (starts.length !== 1 || targets && targets.length !== 1) return { outcome: starts.length > 1 || Boolean(targets && targets.length > 1) ? "ambiguous_entity" : "insufficient_evidence", needsReview: starts.length > 1 || Boolean(targets && targets.length > 1), results: [], plan: { maximumDepth: depth, maximumResults: limit, direction } };
 const entities = new Map(graph.entities.map((entity) => [entity.id, entity]));
 const frontier: Array<{ entity: Entity; chain: Relationship[]; visited: Set<string> }> = [{ entity: starts[0]!, chain: [], visited: new Set([starts[0]!.id]) }];
 const results: Array<{ entity: Entity; chain: Relationship[]; confidence: number }> = [];
 let expanded = 0, inspectedEdges = 0, truncated = false;
 while (frontier.length && results.length < limit && expanded < 500 && inspectedEdges < 20000) {
  const current = frontier.shift()!; expanded++;
  if (current.chain.length >= depth) continue;
  for (const edge of graph.relationships) {
   if (++inspectedEdges > 20000) { truncated = true; break; }
   const nextId = direction !== "inbound" && edge.fromId === current.entity.id ? edge.toId : direction !== "outbound" && edge.toId === current.entity.id ? edge.fromId : undefined;
   if (!nextId || current.visited.has(nextId) || input.relationshipTypes?.length && !input.relationshipTypes.includes(edge.relationshipType)) continue;
   const entity = entities.get(nextId)!, chain = [...current.chain, edge];
   if (!targets || targets[0]!.id === entity.id) results.push({ entity, chain, confidence: Math.min(starts[0]!.confidence, entity.confidence, ...chain.map((step) => step.confidence)) });
   if (results.length >= limit) { truncated = true; break; }
   if (frontier.length >= 500) { truncated = true; continue; }
   frontier.push({ entity, chain, visited: new Set([...current.visited, entity.id]) });
  }
 }
 return { outcome: results.length ? "answered" : "insufficient_evidence", needsReview: false, results, plan: { maximumDepth: depth, maximumResults: limit, direction, expanded, inspectedEdges, truncated: truncated || frontier.length > 0 } };
}
export async function entityReviews(repository: BrainRepository, context: OperationContext, input: { cursor?: string; limit?: number } = {}) {
 const limit = input.limit ?? 100;
 if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("review limit must be between 1 and 100");
 if (input.cursor !== undefined) bounded(input.cursor, 256);
 const snapshot = await scopedSnapshot(repository, context);
 const reviews = [];
 const selected = snapshot.pages.filter((page) => page.source?.type === REVIEW_SOURCE && recordVisible(page, context) && (!input.cursor || page.id > input.cursor)).sort((left, right) => left.id.localeCompare(right.id));
 for (const page of selected.slice(0, limit)) {
  const review = await definition<{ status: string; action: string; proposed: EntityDefinition; candidates: Array<{ id: string; revision: string }> }>(repository, snapshot, page);
  if (["applying", "accepted", "rejected"].includes(review.status)) {
   const resolution = (review as unknown as EntityReview).resolution;
   reviews.push({ id: page.id, revision: page.revision, status: review.status, action: review.action, ...(resolution ? { decision: resolution.decision, targetId: resolution.targetId, idempotencyKey: resolution.idempotencyKey, expectedRevision: resolution.expectedRevision } : {}) });
   continue;
  }
  try {
   if (!active(review.proposed)) throw new EvidenceError();
   const checked = await verified(repository, snapshot, context, review.proposed);
   if (!Array.isArray(review.candidates) || review.candidates.some((candidate) => !snapshot.pages.some((entry) => entry.id === candidate.id && entry.revision === candidate.revision && recordVisible(entry, context)))) throw new EvidenceError();
   reviews.push({ ...review, proposed: { ...review.proposed, evidence: checked.evidence }, id: page.id, revision: page.revision });
  } catch (error) {
   if (!(error instanceof EvidenceError)) throw error;
   reviews.push({ id: page.id, revision: page.revision, status: "stale", reason: "evidence_or_candidate_changed_expired_or_inaccessible" });
  }
 }
 return { reviews, ...(selected.length > limit ? { nextCursor: selected[limit - 1]!.id } : {}) };
}

type ReviewResolution = {
 requestHash: string; idempotencyKey: string; expectedRevision: string; decision: "merge" | "separate" | "reject";
 targetId?: string; targetRevision?: string; merged?: EntityDefinition;
 original?: { id: string; revision: string; definition: EntityDefinition };
 result?: { targetId: string; targetRevision: string };
};
type EntityReview = { version: 1; status: "pending" | "applying" | "accepted" | "rejected"; action: "entity-merge"; proposed: EntityDefinition; candidates: Array<{ id: string; revision: string }>; originalEntity?: { id: string; revision: string }; resolution?: ReviewResolution };
export interface EntityReviewInput { id: string; expectedRevision: string; idempotencyKey: string; decision: "merge" | "separate" | "reject"; targetId?: string }
export class EntityReviewError extends Error {
 readonly retryable = false;
 constructor(readonly code: string, message: string) { super(message); }
 readonly suggestedFix = "Inspect the current entity review, evidence, and candidate revisions before retrying.";
}
function mergeDefinition(target: EntityDefinition, proposed: EntityDefinition, original?: EntityDefinition): EntityDefinition {
 const definitions = [target, proposed, ...(original ? [original] : [])].map((item) => ({ ...item, ...base(item) }));
 if (definitions.some((item) => item.entityType !== target.entityType)) throw new EntityReviewError("entity_type_conflict", "Entity types differ; correct the proposal before merging.");
 const aliases = [...new Set(definitions.flatMap((item) => [item.name, ...item.aliases]).map((alias) => alias.trim()).filter((alias) => normalized(alias) !== normalized(target.name)))].sort();
 const evidence = [...new Map(definitions.flatMap((item) => item.evidence).map((citation) => [canonical({ ...citation, authorizationScope: undefined }), citation])).values()];
 if (aliases.length > 20 || evidence.length > 10) throw new EntityReviewError("entity_merge_budget_exceeded", "Merged aliases or evidence exceed the bounded record budget.");
 const starts = definitions.flatMap((item) => item.validFrom ? [item.validFrom] : []), ends = definitions.flatMap((item) => item.validUntil ? [item.validUntil] : []);
 const validFrom = starts.sort().at(-1), validUntil = ends.sort().at(0);
 if (validFrom && validUntil && validUntil <= validFrom) throw new EntityReviewError("entity_validity_conflict", "Entity validity periods do not overlap.");
 return { version: 1, name: target.name, entityType: target.entityType, aliases, evidence, confidence: Math.min(...definitions.map((item) => item.confidence)), ...(validFrom ? { validFrom } : {}), ...(validUntil ? { validUntil } : {}) };
}
export async function resolveEntityReview(repository: BrainRepository, context: OperationContext, input: EntityReviewInput, options: { faultInjector?: (point: "after-intent" | "after-target" | "after-redirect") => Promise<void> } = {}) {
 if (context.scope !== "admin" || context.allowedAccessLabels !== undefined) throw new EntityReviewError("owner_required", "Entity merge review requires unrestricted owner administration.");
 const check = () => { if (context.signal?.aborted) throw new EntityReviewError("operation_cancelled", "Entity review was cancelled; its persisted intent can be resumed."); };
 check();
 for (const value of [input.id, input.expectedRevision, input.idempotencyKey]) bounded(value, 256);
 if (input.targetId !== undefined) bounded(input.targetId, 256);
 if (!["merge", "separate", "reject"].includes(input.decision) || input.decision === "merge" && !input.targetId || input.decision !== "merge" && input.targetId !== undefined) throw new EntityReviewError("invalid_review_decision", "Choose merge with a candidate ID, or separate/reject without a candidate.");
 const requestHash = hash(canonical(input));
 let snapshot = await scopedSnapshot(repository, context);
 const getReview = async () => {
  const page = snapshot.pages.find((entry) => entry.id === input.id && entry.source?.type === REVIEW_SOURCE && recordVisible(entry, context));
  if (!page) throw new EvidenceError();
  const review = await definition<EntityReview>(repository, snapshot, page);
  return { page, review };
 };
 let { page, review } = await getReview();
 if (review.resolution) {
  if (review.resolution.requestHash !== requestHash) throw new EntityReviewError("review_resolution_conflict", "Review is already bound to another decision.");
  if (["accepted", "rejected"].includes(review.status)) return { id: page.id, revision: page.revision, status: review.status, ...review.resolution.result, replayed: true };
 } else {
  if (review.status !== "pending" || page.revision !== input.expectedRevision) throw new EntityReviewError("stale_review", "Review revision changed.");
  const resolution: ReviewResolution = { requestHash, idempotencyKey: input.idempotencyKey, expectedRevision: input.expectedRevision, decision: input.decision };
  if (input.decision !== "reject") {
   if (!active(review.proposed)) throw new EvidenceError();
   const checked = await verified(repository, snapshot, context, review.proposed);
   if (!Array.isArray(review.candidates) || review.candidates.some((candidate) => !snapshot.pages.some((entry) => entry.id === candidate.id && entry.revision === candidate.revision && recordVisible(entry, context)))) throw new EntityReviewError("stale_review", "An entity candidate changed.");
   const graph = await records(repository, snapshot, context);
   let original: Entity | undefined;
   if (review.originalEntity) {
    original = graph.entities.find((entity) => entity.id === review.originalEntity!.id && entity.revision === review.originalEntity!.revision);
    if (!original) throw new EntityReviewError("stale_review", "The original entity changed.");
   }
   if (input.decision === "separate") {
    resolution.targetId = original?.id; resolution.targetRevision = original?.revision;
    resolution.merged = { ...review.proposed, evidence: checked.evidence };
   } else {
    if (!review.candidates.some((candidate) => candidate.id === input.targetId)) throw new EntityReviewError("invalid_review_target", "Merge target must be one of the reviewed candidates.");
    const target = graph.entities.find((entity) => entity.id === input.targetId);
    if (!target) throw new EvidenceError();
    if (original) resolution.original = { id: original.id, revision: original.revision, definition: await definition<EntityDefinition>(repository, snapshot, snapshot.pages.find((entry) => entry.id === original!.id)!) };
    resolution.targetId = target.id; resolution.targetRevision = target.revision;
    resolution.merged = mergeDefinition(await definition<EntityDefinition>(repository, snapshot, snapshot.pages.find((entry) => entry.id === target.id)!), { ...review.proposed, evidence: checked.evidence }, resolution.original?.definition);
   }
   await verified(repository, snapshot, context, resolution.merged);
  }
  review = { ...review, status: input.decision === "reject" ? "rejected" : "applying", resolution };
  check();
  const result = await writeRecord(repository, snapshot, context, REVIEW_SOURCE, { id: page.id, expectedRevision: page.revision, idempotencyKey: "review-intent:" + hash(canonical([input.id, input.idempotencyKey])) }, review, page.accessLabels ?? []);
  if (input.decision === "reject") return { id: page.id, revision: result.revision, status: "rejected", replayed: false };
  await options.faultInjector?.("after-intent");
  snapshot = await scopedSnapshot(repository, context); ({ page, review } = await getReview());
 }
 const resolution = review.resolution!;
 if (review.status !== "applying" || !["merge", "separate"].includes(resolution.decision) || !resolution.merged || resolution.decision === "merge" && (!resolution.targetId || !resolution.targetRevision)) throw new EntityReviewError("invalid_review_state", "Review resolution state is invalid.");
 if (!active(resolution.merged)) throw new EvidenceError();
 await verified(repository, snapshot, context, resolution.merged);
 check();
 const target = await writeRecord(repository, snapshot, context, ENTITY_SOURCE, { id: resolution.targetId, expectedRevision: resolution.targetRevision, idempotencyKey: "review-merge:" + hash(canonical([input.id, input.idempotencyKey])) }, resolution.merged, page.accessLabels ?? []);
 if (target.currentRevision !== target.revision) throw new EntityReviewError("stale_review", "The merge target changed after this resolution began.");
 await options.faultInjector?.("after-target");
 if (resolution.decision === "merge" && resolution.original) {
  snapshot = await scopedSnapshot(repository, context);
  const original = resolution.original;
  await verified(repository, snapshot, context, original.definition);
  check();
  const redirected = await writeRecord(repository, snapshot, context, ENTITY_SOURCE, { id: original.id, expectedRevision: original.revision, idempotencyKey: "review-redirect:" + hash(canonical([input.id, input.idempotencyKey])) }, { ...original.definition, mergedInto: resolution.targetId, mergeReviewId: input.id }, page.accessLabels ?? []);
  if (redirected.currentRevision !== redirected.revision) throw new EntityReviewError("stale_review", "The original entity changed after this resolution began.");
  await options.faultInjector?.("after-redirect");
 }
 snapshot = await scopedSnapshot(repository, context); ({ page, review } = await getReview());
 if (review.status === "accepted" && review.resolution?.requestHash === requestHash) return { id: page.id, revision: page.revision, status: "accepted", ...review.resolution.result, replayed: true };
 if (review.status !== "applying" || review.resolution?.requestHash !== requestHash) throw new EntityReviewError("review_resolution_conflict", "Review state changed during resolution.");
 const completed = { ...review, status: "accepted", resolution: { ...review.resolution, result: { targetId: target.id, targetRevision: target.revision } } };
 check();
 const result = await writeRecord(repository, snapshot, context, REVIEW_SOURCE, { id: page.id, expectedRevision: page.revision, idempotencyKey: "review-complete:" + hash(canonical([input.id, input.idempotencyKey])) }, completed, page.accessLabels ?? []);
 return { id: page.id, revision: result.revision, status: "accepted", targetId: target.id, targetRevision: target.revision, replayed: false };
}
