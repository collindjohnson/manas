import type { RelationDetails } from "./maintenance-assertions";
import { createHash } from "node:crypto";
import type { BrainRepository, BrainSnapshot, BrainManifestEntry } from "./repository";
import type { OperationContext } from "./operation-registry";
import { recordVisible, scopedSnapshot, verifyEvidence } from "./evidence-contract";
import type { Citation } from "./pglite-indexer";

export const MAINTENANCE_PROPOSAL_SOURCE = "manas-maintenance-proposal";
export type Reference = { id: string; revision: string };
export type Proposal = { version: 1; key: string; batch?: string; kind: "duplicate" | "stale-evidence" | "fact-extraction" | "relationship" | "contradiction"; details?: RelationDetails | { left: RelationDetails; right: RelationDetails }; evidence?: Citation[]; status: "pending" | "dismissed" | "accepted"; approval?: { idempotencyKey: string; expectedRevision: string; relationshipId: string }; sources: Reference[]; createdAt: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function owner(context: OperationContext) {
 if (context.scope !== "admin" || context.allowedAccessLabels !== undefined) throw Object.assign(new Error("Maintenance requires unrestricted owner administration."), { code: "owner_access_required", retryable: false, suggestedFix: "Use the local owner administration client." });
}
function canonical(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(canonical);
 if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== "confidence" && item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
 return value;
}
function key(kind: Proposal["kind"], sources: Reference[], details?: Proposal["details"], batch?: string) {
 const identity = details && kind === "contradiction" && "left" in details ? [canonical(details.left), canonical(details.right)].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : canonical(details);
 return hash(JSON.stringify(batch ? [kind, sources, identity ?? null, batch] : details ? [kind, sources, identity] : [kind, sources]));
}
function active(details: RelationDetails) {
 return (!details.validFrom || Date.parse(details.validFrom) <= Date.now()) && (!details.validUntil || Date.parse(details.validUntil) > Date.now());
}
export async function readMaintenanceProposal(repository: BrainRepository, snapshot: BrainSnapshot, page: BrainManifestEntry): Promise<Proposal> {
 const value = JSON.parse((await repository.readPage(snapshot, page.id)).content) as Proposal;
 if (value.batch !== undefined && (typeof value.batch !== "string" || !/^window:\d+:\d+$/.test(value.batch))) throw new Error("Invalid maintenance window identity.");
 if (value.version !== 1 || !["duplicate", "stale-evidence", "fact-extraction", "relationship", "contradiction"].includes(value.kind) || !["pending", "dismissed", "accepted"].includes(value.status) || !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 2 || value.sources.some((source) => typeof source.id !== "string" || typeof source.revision !== "string") || key(value.kind, value.sources, value.details, value.batch) !== value.key) throw new Error("Invalid maintenance proposal.");
 return value;
}
export async function maintenanceProposalCurrent(repository: BrainRepository, snapshot: BrainSnapshot, context: OperationContext, value: Proposal) {
 if (!value.sources.every((source) => snapshot.pages.some((page) => page.id === source.id && page.revision === source.revision && recordVisible(page, context)))) return false;
 for (const citation of value.evidence ?? []) { try { await verifyEvidence(repository, snapshot, context, citation); } catch { return false; } }
 if (value.kind === "relationship" && (!value.details || !active(value.details as RelationDetails))) return false;
 if (value.kind === "contradiction") {
  const pair = value.details as { left?: RelationDetails; right?: RelationDetails } | undefined;
  if (!pair?.left || !pair.right || !active(pair.left) || !active(pair.right)) return false;
 }
 return true;
}
/** Source text is returned only after revalidating current evidence. */
export async function maintenanceProposals(repository: BrainRepository, context: OperationContext, input: { limit?: number; after?: string } = {}) {
 owner(context);
 const limit = input.limit ?? 50;
 if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Maintenance limit must be 1 to 100.");
 const snapshot = await scopedSnapshot(repository, context);
 const pages = snapshot.pages.filter((page) => !page.deleted && page.source?.type === MAINTENANCE_PROPOSAL_SOURCE && (!input.after || page.id > input.after)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit + 1);
 const items = [];
 for (const page of pages.slice(0, limit)) {
  const value = await readMaintenanceProposal(repository, snapshot, page);
  const fresh = await maintenanceProposalCurrent(repository, snapshot, context, value);
  const evidence = [];
  if (fresh) for (const citation of value.evidence ?? []) evidence.push(await verifyEvidence(repository, snapshot, context, citation));
  items.push({ id: page.id, revision: page.revision, kind: value.kind, status: value.status, ...(value.approval ? { approval: value.approval } : {}), sources: value.sources, freshness: fresh ? "current" : "stale", ...(evidence.length ? { evidence: evidence.map((item) => ({ text: item.text, citation: item.citation })) } : {}), ...(fresh && value.details ? { details: value.details } : {}), createdAt: value.createdAt });
 }
 return { items, next: pages.length > limit ? pages[limit - 1]!.id : null };
}
export async function dismissMaintenanceProposal(repository: BrainRepository, context: OperationContext, input: { id: string; expectedRevision: string }) {
 owner(context);
 const snapshot = await scopedSnapshot(repository, context);
 const page = snapshot.pages.find((page) => !page.deleted && page.id === input.id && page.source?.type === MAINTENANCE_PROPOSAL_SOURCE);
 if (!page) throw new Error("Maintenance proposal unavailable.");
 const value = await readMaintenanceProposal(repository, snapshot, page);
 if (page.revision !== input.expectedRevision) throw Object.assign(new Error("Maintenance proposal changed."), { code: "revision_conflict", retryable: false });
 if (value.status === "accepted") throw Object.assign(new Error("Accepted relationships must be managed through typed graph operations."), { code: "proposal_already_accepted", retryable: false });
 if (value.status === "dismissed") return { id: page.id, revision: page.revision, status: value.status };
 const result = await repository.putPage(page.path, JSON.stringify({ ...value, status: "dismissed" }) + "\n", page.revision, page.source, snapshot.commit);
 return { id: result.id, revision: result.revision, status: "dismissed" };
}
export async function persistMaintenanceProposal(repository: BrainRepository, context: OperationContext, kind: Proposal["kind"], sources: Reference[], check: () => Promise<void>, evidence?: Citation[], details?: Proposal["details"], batch?: string) {
 const snapshot = await scopedSnapshot(repository, context);
 const proposalKey = key(kind, sources, details, batch);
 const path = "notes/maintenance/" + proposalKey + ".md";
 const legacyKey = kind === "fact-extraction" && batch ? key(kind, sources, details) : proposalKey;
 const existing = snapshot.pages.find((page) => page.path === path || page.path === "notes/maintenance/" + legacyKey + ".md");
 if (existing) {
  // A dismissal (or a tombstone) suppresses this exact evidence revision forever.
  if (existing.source?.type !== MAINTENANCE_PROPOSAL_SOURCE || ![proposalKey, legacyKey].includes(existing.source.externalId)) throw new Error("Maintenance path is owned by other content.");
  return { id: existing.id, revision: existing.revision, status: existing.deleted ? "dismissed" : (await readMaintenanceProposal(repository, snapshot, existing)).status };
 }
 const value: Proposal = { version: 1, key: proposalKey, kind, status: "pending", sources, ...(batch ? { batch } : {}), ...(evidence ? { evidence } : {}), ...(details ? { details } : {}), createdAt: new Date().toISOString() };
 if (!await maintenanceProposalCurrent(repository, snapshot, context, value)) return;
 const labels = [...new Set(sources.flatMap((source) => snapshot.pages.find((page) => page.id === source.id)!.accessLabels ?? []))].sort();
 await check();
 if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error("Maintenance proposal exceeds its size budget.");
 const result = await repository.putPage(path, JSON.stringify(value) + "\n", undefined, { type: MAINTENANCE_PROPOSAL_SOURCE, externalId: proposalKey, visibilityLabels: labels }, snapshot.commit);
 return { id: result.id, revision: result.revision, status: "pending" };
}
