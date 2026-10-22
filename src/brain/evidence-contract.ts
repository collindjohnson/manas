import { createHash } from "node:crypto";
import type { BrainRepository, BrainSnapshot, BrainManifestEntry } from "./repository";
import type { OperationContext } from "./operation-registry";
import type { Citation } from "./pglite-indexer";
import { memoryIsActive } from "./memory";

const NON_PRIMARY_SOURCES = new Set(["manas-pinned-question", "manas-entity", "manas-relationship", "manas-entity-review", "manas-generated-answer", "manas-maintenance-proposal", "manas-open-loop", "manas-meeting-preparation"]);
export function isPrimaryEvidence(page: { source?: { type: string } }) { return !NON_PRIMARY_SOURCES.has(page.source?.type ?? ""); }
export class EvidenceError extends Error {
 readonly code = "evidence_unavailable"; readonly retryable = false;
 readonly suggestedFix = "Retrieve current authorized evidence and supply its exact citation.";
 constructor() { super("Evidence is invalid, withdrawn, expired, or inaccessible."); }
}
export function recordVisible(page: BrainManifestEntry, context: OperationContext) {
 return !page.deleted && !page.stale && memoryIsActive(page) && (context.allowedAccessLabels === undefined || (page.accessLabels ?? []).every((label) => context.allowedAccessLabels!.includes(label)));
}
export async function scopedSnapshot(repository: BrainRepository, context: OperationContext) {
 const snapshot = await repository.snapshot();
 if ((context.tenantId ?? "local") !== "local" || context.brainId && context.brainId !== snapshot.brainId) throw new EvidenceError();
 return snapshot;
}
export async function verifyEvidence(repository: BrainRepository, snapshot: BrainSnapshot, context: OperationContext, input: unknown): Promise<{ citation: Citation; text: string; labels: string[] }> {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new EvidenceError();
 const citation = input as Citation;
 if (citation.tenantId !== (context.tenantId ?? "local") || citation.brainId !== snapshot.brainId || typeof citation.commit !== "string" || !/^[a-f0-9]{40}$/.test(citation.commit) || !Number.isSafeInteger(citation.startOffset) || !Number.isSafeInteger(citation.endOffset) || citation.startOffset < 0 || citation.endOffset <= citation.startOffset || typeof citation.chunkId !== "string" || !citation.chunkId || !citation.schemaPack || typeof citation.schemaPack.id !== "string" || typeof citation.schemaPack.version !== "string") throw new EvidenceError();
 const page = snapshot.pages.find((page) => page.id === citation.documentId);
 if (!page || !recordVisible(page, context) || !isPrimaryEvidence(page) || page.revision !== citation.documentRevision || page.revision !== citation.revision || page.path !== citation.path) throw new EvidenceError();
 const old = await repository.snapshot(citation.commit);
 const historical = old.pages.find((entry) => entry.id === page.id);
 if (!historical || historical.revision !== page.revision || historical.path !== citation.path || old.brainId !== snapshot.brainId || old.settings.schemaPack.id !== citation.schemaPack.id || old.settings.schemaPack.version !== citation.schemaPack.version) throw new EvidenceError();
 const content = (await repository.readPage(snapshot, page.id)).content;
 const oldContent = (await repository.readPage(old, page.id)).content;
 const parts = citation.chunkId.split(":");
 const chunkStart = Number(parts[2]), chunkEnd = Number(parts[3]);
 if (parts.length !== 4 || parts[0] !== page.id || !/^[a-f0-9]{64}$/.test(parts[1]!) || !Number.isSafeInteger(chunkStart) || !Number.isSafeInteger(chunkEnd) || chunkStart < 0 || chunkStart > citation.startOffset || chunkEnd < citation.endOffset || chunkEnd > content.length || createHash("sha256").update(content.slice(chunkStart, chunkEnd)).digest("hex") !== parts[1]) throw new EvidenceError();
 if (citation.authorizationScope && (citation.authorizationScope.tenantId !== citation.tenantId || citation.authorizationScope.brainId !== citation.brainId)) throw new EvidenceError();
 const text = content.slice(citation.startOffset, citation.endOffset);
 if (citation.endOffset > content.length || createHash("sha256").update(text).digest("hex") !== citation.contentHash || oldContent.slice(citation.startOffset, citation.endOffset) !== text) throw new EvidenceError();
 return { text, labels: page.accessLabels ?? [], citation: { ...citation, authorizationScope: { tenantId: citation.tenantId, brainId: citation.brainId, allowedAccessLabels: context.allowedAccessLabels ?? null } } };
}
