import { createHash } from "node:crypto";
import type { BrainRepository } from "./repository";
import type { OperationContext } from "./operation-registry";
import type { RelationDetails } from "./maintenance-assertions";
import { scopedSnapshot, recordVisible } from "./evidence-contract";
import { putEntity, putRelationship, resolveEntity, queryRelationships, RELATION_SOURCE } from "./entity-relationships";
import { MAINTENANCE_PROPOSAL_SOURCE, owner, readMaintenanceProposal, maintenanceProposalCurrent } from "./maintenance-proposals";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class MaintenanceReviewError extends Error {
 readonly retryable = false;
 constructor(readonly code: string, message: string, readonly suggestedFix = "Inspect the current source and resolve entity ambiguity before retrying this proposal.") { super(message); }
}
/** One reviewed assertion creates at most two entities and one cited relationship. */
export async function applyRelationshipProposal(repository: BrainRepository, context: OperationContext, input: { id: string; expectedRevision: string; idempotencyKey: string }, check: () => Promise<void> = async () => { if (context.signal?.aborted) throw new MaintenanceReviewError("operation_cancelled", "Proposal application was cancelled."); }) {
 owner(context);
 if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 256) throw new MaintenanceReviewError("invalid_idempotency_key", "A bounded idempotency key is required.");
 let snapshot = await scopedSnapshot(repository, context);
 let page = snapshot.pages.find((page) => page.id === input.id && !page.deleted && page.source?.type === MAINTENANCE_PROPOSAL_SOURCE);
 if (!page) throw new MaintenanceReviewError("proposal_unavailable", "Maintenance proposal is unavailable.");
 const value = await readMaintenanceProposal(repository, snapshot, page);
 const approval = value.approval;
 if (value.status === "accepted") {
  if (approval?.idempotencyKey !== input.idempotencyKey || approval.expectedRevision !== input.expectedRevision) throw new MaintenanceReviewError("proposal_already_accepted", "This proposal was accepted under another approval request.");
  return { id: page.id, revision: page.revision, relationshipId: approval.relationshipId, replayed: true };
 }
 if (page.revision !== input.expectedRevision) throw new MaintenanceReviewError("revision_conflict", "Maintenance proposal changed.");
 if (value.kind !== "relationship" || value.status !== "pending" || !await maintenanceProposalCurrent(repository, snapshot, context, value)) throw new MaintenanceReviewError("proposal_unavailable", "Only a current pending relationship proposal can be applied.");
 const details = value.details as RelationDetails;
 const evidence = value.evidence!;
 const common = { evidence, confidence: details.confidence, ...(details.validFrom ? { validFrom: details.validFrom } : {}), ...(details.validUntil ? { validUntil: details.validUntil } : {}) };
 const entity = async (name: string, entityType: string, side: string) => {
  const found = (await resolveEntity(repository, context, name)).entities;
  if (found.length > 1 || found.length === 1 && found[0]!.entityType !== entityType) throw new MaintenanceReviewError("ambiguous_entity", "The proposed entity has ambiguous identity or type: " + name);
  if (found.length === 1) return found[0]!.id;
  await check();
  const result = await putEntity(repository, context, { ...common, name, entityType, aliases: [], idempotencyKey: "maintenance:" + value.key + ":" + side });
  if (result.needsReview) throw new MaintenanceReviewError("entity_review_required", "Entity creation requires review: " + result.review.id);
  return result.id;
 };
 await check();
 // If the relationship committed before the proposal receipt, verify and reuse
 // the existing edge rather than issuing a different write after an entity merge.
 const receiptKey = "graph.receipt." + hash("maintenance:" + value.key + ":relationship");
 const prior = snapshot.pages.find((candidate) => candidate.source?.type === RELATION_SOURCE && candidate.source.provenance?.metadata?.[receiptKey] && recordVisible(candidate, context));
 let relationshipId: string;
 if (prior) {
  const graph = await queryRelationships(repository, context, { from: details.subject, to: details.object, maximumDepth: 1 });
  if (!graph.results.some((result) => result.chain.some((edge) => edge.id === prior.id))) throw new MaintenanceReviewError("proposal_unavailable", "The committed relationship is no longer current.");
  relationshipId = prior.id;
 } else {
  const fromId = await entity(details.subject, details.subjectType, "from"), toId = await entity(details.object, details.objectType, "to");
  await check();
  relationshipId = (await putRelationship(repository, context, { ...common, fromId, toId, relationshipType: details.predicate, idempotencyKey: "maintenance:" + value.key + ":relationship" })).id;
 }
 await check();
 snapshot = await scopedSnapshot(repository, context);
 page = snapshot.pages.find((candidate) => candidate.id === input.id && !candidate.deleted);
 if (!page) throw new MaintenanceReviewError("proposal_unavailable", "Maintenance proposal was removed.");
 const latest = await readMaintenanceProposal(repository, snapshot, page);
 if (latest.status === "accepted" && latest.approval?.idempotencyKey === input.idempotencyKey && latest.approval.expectedRevision === input.expectedRevision) return { id: page.id, revision: page.revision, relationshipId: latest.approval.relationshipId, replayed: true };
 if (page.revision !== input.expectedRevision || !await maintenanceProposalCurrent(repository, snapshot, context, latest)) throw new MaintenanceReviewError("revision_conflict", "Evidence or proposal changed before approval completed.");
 const graphPage = snapshot.pages.find((candidate) => candidate.id === relationshipId)!;
 const labels = [...new Set([...(page.accessLabels ?? []), ...(graphPage.accessLabels ?? [])])].sort();
 const completed = { ...latest, status: "accepted", approval: { idempotencyKey: input.idempotencyKey, expectedRevision: input.expectedRevision, relationshipId } };
 await check();
 const result = await repository.putPage(page.path, JSON.stringify(completed) + "\n", page.revision, { ...page.source!, visibilityLabels: labels }, snapshot.commit);
 return { id: result.id, revision: result.revision, relationshipId, replayed: false };
}
