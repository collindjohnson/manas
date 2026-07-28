import { createHash } from "node:crypto";
import type { NormalizedDocument, SourceAdapter, SourceCheckpoint, SourceDescriptor } from "./types";
const slash = String.fromCharCode(47);

function validPath(path: string): boolean {
	return Boolean(path) && !path.startsWith(slash) && !path.includes("\\") && !path.split(slash).some((part) => !part || part === "." || part === "..");
}

export function assertSourceDescriptor(descriptor: SourceDescriptor): void {
	if (!descriptor.id.trim() || !descriptor.version.trim() || !descriptor.kind.trim() || typeof descriptor.trusted !== "boolean") throw new Error("invalid source descriptor");
	if (descriptor.compatibility && (!descriptor.compatibility || typeof descriptor.compatibility !== "object" || descriptor.compatibility.minimumEngine !== undefined && !descriptor.compatibility.minimumEngine.trim() || descriptor.compatibility.maximumEngine !== undefined && !descriptor.compatibility.maximumEngine.trim())) throw new Error("invalid source descriptor compatibility");
}

export function assertSourceCheckpoint(checkpoint: SourceCheckpoint | undefined): void {
	if (!checkpoint) return;
	if (typeof checkpoint !== "object" || Array.isArray(checkpoint) || checkpoint.updatedAt !== undefined && (typeof checkpoint.updatedAt !== "string" || Number.isNaN(Date.parse(checkpoint.updatedAt))) || checkpoint.cursor !== undefined && typeof checkpoint.cursor !== "string") throw new Error("invalid source checkpoint");
}

export function assertNormalizedDocuments(sourceId: string, documents: NormalizedDocument[]): void {
	if (!sourceId.trim()) throw new Error("invalid source adapter id");
	const identifiers = new Set<string>();
	for (const document of documents) {
		if (!document.externalId.trim() || identifiers.has(document.externalId)) throw new Error("source documents must have unique external IDs");
		identifiers.add(document.externalId);
		if (!validPath(document.suggestedPath)) throw new Error("source document has unsafe suggested path");
		if (typeof document.content !== "string" || typeof document.deleted !== "boolean") throw new Error("invalid source document");
		const expectedHash = createHash("sha256").update(document.content).digest("hex");
		if (document.contentHash !== undefined && (!/^[a-f0-9]{64}$/.test(document.contentHash) || document.contentHash !== expectedHash)) throw new Error("invalid source content hash");
		if (document.extractionMetadata && Object.entries(document.extractionMetadata).some(([key, value]) => !key.trim() || typeof value !== "string" || value.length > 4096)) throw new Error("invalid extraction metadata");
		if (!document.provenance?.sourceType.trim() || !document.provenance.retrievedAt || Number.isNaN(Date.parse(document.provenance.retrievedAt))) throw new Error("source document is missing valid provenance");
		if (document.externalRevision !== undefined && !document.externalRevision.trim()) throw new Error("invalid source document revision");
		if (document.updatedAt !== undefined && Number.isNaN(Date.parse(document.updatedAt))) throw new Error("invalid source document timestamp");
		if (document.visibilityLabels?.some((label) => !label.trim() || label.length > 128)) throw new Error("invalid source visibility labels");
		if (document.managedSections?.some((section) => !section.trim())) throw new Error("invalid managed source sections");
	}
}

async function collect(adapter: SourceAdapter, checkpoint?: SourceCheckpoint): Promise<NormalizedDocument[]> {
	if (adapter.scan) {
		const documents: NormalizedDocument[] = [];
		for await (const document of adapter.scan(checkpoint)) documents.push(document);
		return documents;
	}
	if (adapter.list) return adapter.list();
	throw new Error("source adapter must implement scan or list");
}

function stableDocument(document: NormalizedDocument): Record<string, unknown> {
	return {
		externalId: document.externalId,
		suggestedPath: document.suggestedPath,
		content: document.content,
		contentHash: document.contentHash,
		externalRevision: document.externalRevision,
		deleted: document.deleted,
		extractionMetadata: document.extractionMetadata,
		visibilityLabels: document.visibilityLabels,
		managedSections: document.managedSections,
		provenance: { ...document.provenance, retrievedAt: undefined },
	};
}

/** Run the shared determinism and normalization gate for a fresh adapter instance. */
export async function verifySourceAdapterConformance(factory: () => SourceAdapter): Promise<{ descriptor: SourceDescriptor; documents: NormalizedDocument[]; deterministic: true; checkpoint?: SourceCheckpoint }> {
	const first = factory();
	const descriptor = first.describe?.() ?? { id: first.id, version: "legacy", kind: "source", trusted: false };
	assertSourceDescriptor(descriptor);
	const checkpoint = first.checkpoint?.();
	assertSourceCheckpoint(checkpoint);
	const documents = await collect(first, undefined);
	assertNormalizedDocuments(descriptor.id, documents);
	const repeated = await collect(factory(), undefined);
	assertNormalizedDocuments(descriptor.id, repeated);
	if (JSON.stringify(documents.map(stableDocument)) !== JSON.stringify(repeated.map(stableDocument))) throw new Error("source adapter scan is not deterministic");
	return { descriptor, documents, deterministic: true, ...(checkpoint ? { checkpoint } : {}) };
}
