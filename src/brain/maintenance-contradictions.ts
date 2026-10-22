import { resolveEntity } from "./entity-relationships";
import type { BrainRepository } from "./repository";
import type { OperationContext } from "./operation-registry";
import type { RelationDetails } from "./maintenance-assertions";
import { scopedSnapshot, recordVisible } from "./evidence-contract";
import { MAINTENANCE_PROPOSAL_SOURCE, readMaintenanceProposal, maintenanceProposalCurrent, persistMaintenanceProposal, type Proposal } from "./maintenance-proposals";
const normalized = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
const functionalPredicates = new Set(["owner is", "is owned by", "is based in", "is located in", "deadline is", "birth date is", "date of birth is"]);
function overlaps(left: RelationDetails, right: RelationDetails) {
 const start = Math.max(left.validFrom ? Date.parse(left.validFrom) : -Infinity, right.validFrom ? Date.parse(right.validFrom) : -Infinity);
 const end = Math.min(left.validUntil ? Date.parse(left.validUntil) : Infinity, right.validUntil ? Date.parse(right.validUntil) : Infinity);
 return start < end;
}
/** Compare derived assertions; supporting evidence always remains the primary source. */
export async function proposeContradictions(repository: BrainRepository, context: OperationContext, check: () => Promise<void>, dryRun = false) {
 const snapshot = await scopedSnapshot(repository, context);
 const pages = snapshot.pages.filter((page) => page.source?.type === MAINTENANCE_PROPOSAL_SOURCE && recordVisible(page, context));
 if (pages.length > 2000) throw Object.assign(new Error("Contradiction scan exceeds the 2000 proposal budget."), { code: "maintenance_budget_exceeded", retryable: false });
 const groups = new Map<string, Proposal[]>();
 for (const page of pages.sort((a, b) => a.id.localeCompare(b.id))) {
  await check();
  const value = await readMaintenanceProposal(repository, snapshot, page);
  if (value.kind !== "relationship" || value.status === "dismissed" || !await maintenanceProposalCurrent(repository, snapshot, context, value)) continue;
  const details = value.details as RelationDetails;
  const predicate = normalized(details.predicate);
  if (!functionalPredicates.has(predicate)) continue;
  const key = JSON.stringify([normalized(details.subject), details.subjectType, predicate]);
  const group = groups.get(key) ?? [];
  group.push(value); groups.set(key, group);
 }
 let pairs = 0, proposed = 0;
 for (const group of groups.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
  if (++pairs > 10000) throw Object.assign(new Error("Contradiction scan exceeds the 10000 comparison budget."), { code: "maintenance_budget_exceeded", retryable: false });
  const left = group[i]!, right = group[j]!;
  const a = left.details as RelationDetails, b = right.details as RelationDetails;
  if (normalized(a.object) === normalized(b.object) && a.objectType === b.objectType || !overlaps(a, b)) continue;
  await check();
  const sources = [...new Map([...left.sources, ...right.sources].map((source) => [source.id, source])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const evidence = [...left.evidence ?? [], ...right.evidence ?? []];
  if (!dryRun) await persistMaintenanceProposal(repository, context, "contradiction", sources, check, evidence, { left: a, right: b });
  proposed++;
 }
 return { comparisons: pairs, candidates: proposed };
}

export async function relationshipNeedsReview(repository: BrainRepository, context: OperationContext, candidateId: string) {
 const snapshot = await scopedSnapshot(repository, context);
 const page = snapshot.pages.find((page) => page.id === candidateId && page.source?.type === MAINTENANCE_PROPOSAL_SOURCE && recordVisible(page, context));
 if (!page) return true;
 const candidate = await readMaintenanceProposal(repository, snapshot, page);
 if (!await maintenanceProposalCurrent(repository, snapshot, context, candidate)) return true;
 const details = candidate.details as RelationDetails;
 if (details.confidence < 0.9) return true;
 for (const [name, type] of [[details.subject, details.subjectType], [details.object, details.objectType]]) {
  const found = (await resolveEntity(repository, context, name!)).entities;
  if (found.length > 1 || found.length === 1 && (found[0]!.entityType !== type || found[0]!.confidence < 0.9)) return true;
 }
 if (!functionalPredicates.has(normalized(details.predicate))) return false;
 for (const other of snapshot.pages.filter((entry) => entry.id !== candidateId && entry.source?.type === MAINTENANCE_PROPOSAL_SOURCE && recordVisible(entry, context))) {
  const value = await readMaintenanceProposal(repository, snapshot, other);
  if (value.kind !== "relationship" || value.status === "dismissed" || !await maintenanceProposalCurrent(repository, snapshot, context, value)) continue;
  const otherDetails = value.details as RelationDetails;
  if (normalized(details.subject) === normalized(otherDetails.subject) && details.subjectType === otherDetails.subjectType && normalized(details.predicate) === normalized(otherDetails.predicate) && (normalized(details.object) !== normalized(otherDetails.object) || details.objectType !== otherDetails.objectType) && overlaps(details, otherDetails)) return true;
 }
 return false;
}
