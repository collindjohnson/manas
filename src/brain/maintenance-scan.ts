import { applyRelationshipProposal } from "./maintenance-approval";
import { proposeContradictions, relationshipNeedsReview } from "./maintenance-contradictions";
import { LocalModelConfigurationError } from "./local-inference";
import { extractMaintenanceAnalysis, completeMaintenanceAnalysis } from "./maintenance-extraction";
import type { GenerationProvider } from "./providers";
import type { BrainRepository, BrainSnapshot, BrainManifestEntry } from "./repository";
import type { BrainStore } from "./store";
import type { OperationContext } from "./operation-registry";
import { isPrimaryEvidence, recordVisible, scopedSnapshot, verifyEvidence } from "./evidence-contract";
import { enqueueJob, updateJobProgress, type BrainJob } from "./jobs";
import { pinStatus, enqueuePinRefresh } from "./maintained-answers";
import type { Citation } from "./pglite-indexer";

import { persistMaintenanceProposal, type Proposal, type Reference } from "./maintenance-proposals";
export { MAINTENANCE_PROPOSAL_SOURCE, maintenanceProposals, dismissMaintenanceProposal } from "./maintenance-proposals";
type Dependencies = { repository: BrainRepository; store: BrainStore; workerId: string; provider?: GenerationProvider; managedWrites?: () => boolean };
async function stale(repository: BrainRepository, snapshot: BrainSnapshot, context: OperationContext, page: BrainManifestEntry) {
 if (!["manas-entity", "manas-relationship"].includes(page.source?.type ?? "")) return false;
 const value = JSON.parse((await repository.readPage(snapshot, page.id)).content) as { evidence?: Citation[]; validUntil?: string; status?: string };
 if (value.status && value.status !== "active") return false;
 if (value.validUntil && Date.parse(value.validUntil) <= Date.now()) return true;
 for (const citation of value.evidence ?? []) {
  try { await verifyEvidence(repository, snapshot, context, citation); } catch { return true; }
 }
 return false;
}
/** Bounded canonical scan. Supplied facts/findings are deliberately not inputs. */
export function maintenanceScanHandler(dependencies: Dependencies) {
 return async (job: BrainJob) => {
  const payload = job.payload as { brainId: string; maximumItems?: number; after?: string; dryRun?: boolean };
  if (["fact-extraction", "entity-enrichment"].includes(job.type) && !payload.dryRun && !dependencies.provider) throw new LocalModelConfigurationError();
  const maximumItems = payload.maximumItems ?? 100;
  if (!Number.isInteger(maximumItems) || maximumItems < 1 || maximumItems > 500) throw new Error("Maintenance maximumItems must be 1 to 500.");
  const context: OperationContext = { scope: "admin", tenantId: job.tenantId, brainId: payload.brainId, principal: "maintenance-worker" };
  let checking: Promise<void> | undefined;
  const check = () => checking ??= (async () => {
   const live = await dependencies.store.query<{ id: string }>("UPDATE brain_jobs SET lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='running' AND worker_id=$3 AND attempts=$4 AND lease_expires_at>now() RETURNING id", [job.id, job.tenantId, dependencies.workerId, job.attempts]);
   if (!live.length) throw new Error("Maintenance job cancelled or lease lost.");
  })().finally(() => { checking = undefined; });
  await check();
  const timer = setInterval(() => { void check().catch(() => {}); }, 1000);
  try {
   const snapshot = await scopedSnapshot(dependencies.repository, context);
   // Resume the exact frozen plan; changed revisions are skipped rather than replaced.
   const saved = job.progress as { version?: number; plan?: Reference[]; next?: number; inspected?: number } | undefined;
   const plan = saved?.version === 1 && saved.plan ? saved.plan : snapshot.pages.filter((page) => recordVisible(page, context) && (!payload.after || page.id > payload.after) && (isPrimaryEvidence(page) || ["manas-entity", "manas-relationship", "manas-pinned-question"].includes(page.source?.type ?? ""))).sort((a, b) => a.id.localeCompare(b.id)).map((page) => ({ id: page.id, revision: page.revision }));
   if (plan.length > 10000 || plan.some((item) => typeof item.id !== "string" || typeof item.revision !== "string")) throw new Error("Maintenance scan plan exceeds its 10000 item budget or is invalid.");
   const start = saved?.version === 1 ? saved.next ?? 0 : 0;
   if (!Number.isInteger(start) || start < 0 || start > plan.length) throw new Error("Invalid maintenance resume cursor.");
   let units = 0;
   let next = start, inspected = saved?.inspected ?? 0;
   let proposed = 0;
   const propose = async (kind: Proposal["kind"], sources: Reference[], evidence?: Citation[], details?: Proposal["details"], batch?: string) => { proposed++; if (!payload.dryRun) return persistMaintenanceProposal(dependencies.repository, context, kind, sources, check, evidence, details, batch); };
   const save = async () => { await check(); await updateJobProgress(dependencies.store, job.id, dependencies.workerId, { version: 1, plan, next, inspected, remaining: plan.length - next, candidatesThisAttempt: proposed, dryRun: payload.dryRun === true, extraction: dependencies.provider ? "local-model" : "unavailable" }, job.tenantId); };
   await save();
   const deadline = Date.now() + 120000;
   while (next < plan.length && units < maximumItems && Date.now() < deadline) {
    await check();
    units++;
    let pageDone = true;
    const latest = await scopedSnapshot(dependencies.repository, context);
    const source = plan[next]!;
    const page = latest.pages.find((page) => page.id === source.id && page.revision === source.revision && recordVisible(page, context));
    if (page) {
     if (isPrimaryEvidence(page)) {
      // Exact duplicates only; never propose a speculative semantic merge.
      const duplicate = latest.pages.filter((candidate) => candidate.id < page.id && isPrimaryEvidence(candidate) && recordVisible(candidate, context) && candidate.contentHash === page.contentHash).sort((a, b) => a.id.localeCompare(b.id))[0];
      if (duplicate) await propose("duplicate", [{ id: duplicate.id, revision: duplicate.revision }, source]);
      if (dependencies.provider && !payload.dryRun) {
       const analysis = await extractMaintenanceAnalysis({ ...dependencies, provider: dependencies.provider, snapshot: latest, page, check });
       if (analysis.evidence.length) await propose("fact-extraction", [source], analysis.evidence, undefined, analysis.batch);
       for (const finding of analysis.relationships) {
        const proposed = await propose("relationship", [source], finding.evidence, finding.details);
        if (proposed?.status === "pending" && finding.details.confidence >= 0.9 && dependencies.managedWrites?.() && !await relationshipNeedsReview(dependencies.repository, context, proposed.id)) {
         const writeCheck = async () => { await check(); if (!dependencies.managedWrites?.()) throw Object.assign(new Error("Managed maintenance writes were disabled."), { code: "managed_writes_disabled", retryable: false }); };
         try { await applyRelationshipProposal(dependencies.repository, context, { id: proposed.id, expectedRevision: proposed.revision, idempotencyKey: "managed:" + proposed.id }, writeCheck); }
         catch (error) { if (!["ambiguous_entity", "entity_review_required"].includes(String((error as { code?: string }).code))) throw error; }
        }
       }
       await check();
       await completeMaintenanceAnalysis(dependencies.store, latest, page, dependencies.provider, analysis.analyzer);
       pageDone = analysis.done;
      }
     } else if (await stale(dependencies.repository, latest, context, page)) await propose("stale-evidence", [source]);
     else if (page.source?.type === "manas-pinned-question") {
      const status = await pinStatus(dependencies, context, page.id);
      if (status.answer.freshness !== "current" && !payload.dryRun) { await check(); await enqueuePinRefresh(dependencies, context, page.id); }
     }
     if (pageDone) inspected++;
    }
    if (pageDone) next++;
    await save();
   }
   await proposeContradictions(dependencies.repository, context, check, payload.dryRun === true);
   await save();
   if (next < plan.length) {
    await check();
    await enqueueJob(dependencies.store, { type: "maintenance-scan", tenantId: job.tenantId, payload: { brainId: payload.brainId, maximumItems, ...(next > 0 ? { after: plan[next - 1]!.id } : payload.after ? { after: payload.after } : {}), ...(payload.dryRun ? { dryRun: true } : {}) }, idempotencyKey: "maintenance-continuation:" + job.id });
   }
  } finally { clearInterval(timer); }
 };
}
