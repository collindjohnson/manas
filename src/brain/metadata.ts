export interface TombstonePolicy {
	mode: "recoverable-trash";
	retentionDays: number;
	deletionTimestampField: "deletedAt";
}

export interface ProtectedBranchPolicy {
	branches: string[];
	requireExpectedHead: boolean;
	allowForcePush: false;
	pushMode: "explicit";
}

export interface CanonicalRemoteConfiguration {
	name: string;
	url: string;
	branch: string;
	fetchMode: "explicit";
	pushMode: "explicit";
}

export interface BrainIdentityMetadata {
	metadataVersion: 1;
	brainId: string;
	repositoryId: string;
	generatedContentOwner: string;
	managedSectionOwner: string;
	tombstonePolicy: TombstonePolicy;
	canonicalRemote: CanonicalRemoteConfiguration | null;
	protectedBranchPolicy: ProtectedBranchPolicy;
}

export interface BrainSourceMetadata {
	type: string;
	externalId: string;
	provenance?: { sourceType: string; sourcePath?: string; retrievedAt: string; metadata?: Record<string, string> };
	externalRevision?: string;
	contentHash?: string;
	extractionMetadata?: Record<string, string>;
	updatedAt?: string;
	visibilityLabels?: string[];
	managedSections?: string[];
}

export interface BrainManifestMetadataEntry {
	id: string;
	path: string;
	contentHash: string;
	revision: string;
	source?: BrainSourceMetadata;
	deleted?: boolean;
	deletedAt?: string;
	stale?: boolean;
	accessLabels?: string[];
}

export class BrainMetadataError extends Error {
	readonly issues: string[];

	constructor(file: string, issues: string[]) {
		super(["invalid " + file, ...issues.map((issue) => "- " + issue)].join("\n"));
		this.name = "BrainMetadataError";
		this.issues = issues;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, issues: string[]): string | undefined {
	if (typeof value !== "string" || !value.trim()) {
		issues.push(field + " must be a non-empty string");
		return undefined;
	}
	return value;
}

function requiredUuid(value: unknown, field: string, issues: string[]): string | undefined {
	const result = requiredString(value, field, issues);
	if (result && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result)) issues.push(field + " must be a UUID");
	return result;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], field: string, issues: string[]): void {
	const accepted = new Set(allowed);
	for (const key of Object.keys(value)) if (!accepted.has(key)) issues.push(field + "." + key + " is not recognized");
}

function validTimestamp(value: unknown, field: string, issues: string[]): string | undefined {
	const result = requiredString(value, field, issues);
	if (result && Number.isNaN(Date.parse(result))) issues.push(field + " must be an ISO timestamp");
	return result;
}

function stringMap(value: unknown, field: string, issues: string[]): Record<string, string> | undefined {
	if (!isRecord(value) || Object.entries(value).some(([key, item]) => !key.trim() || typeof item !== "string" || item.length > 4096)) {
		issues.push(field + " must be an object of bounded string values");
		return undefined;
	}
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item as string]));
}

function optionalStringList(value: unknown, field: string, issues: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	return stringList(value, field, issues);
}

function assertSourceMetadata(value: unknown, field: string, issues: string[]): BrainSourceMetadata | undefined {
	if (!isRecord(value)) {
		issues.push(field + " must be an object");
		return undefined;
	}
	rejectUnknown(value, ["type", "externalId", "provenance", "externalRevision", "contentHash", "extractionMetadata", "updatedAt", "visibilityLabels", "managedSections"], field, issues);
	const type = requiredString(value.type, field + ".type", issues);
	const externalId = requiredString(value.externalId, field + ".externalId", issues);
	const externalRevision = value.externalRevision === undefined ? undefined : requiredString(value.externalRevision, field + ".externalRevision", issues);
	const contentHash = value.contentHash === undefined ? undefined : requiredString(value.contentHash, field + ".contentHash", issues);
	const updatedAt = value.updatedAt === undefined ? undefined : validTimestamp(value.updatedAt, field + ".updatedAt", issues);
	const extractionMetadata = value.extractionMetadata === undefined ? undefined : stringMap(value.extractionMetadata, field + ".extractionMetadata", issues);
	const visibilityLabels = optionalStringList(value.visibilityLabels, field + ".visibilityLabels", issues);
	const managedSections = optionalStringList(value.managedSections, field + ".managedSections", issues);
	let provenance: BrainSourceMetadata["provenance"];
	if (value.provenance !== undefined) {
		if (!isRecord(value.provenance)) issues.push(field + ".provenance must be an object");
		else {
			rejectUnknown(value.provenance, ["sourceType", "sourcePath", "retrievedAt", "metadata"], field + ".provenance", issues);
			const sourceType = requiredString(value.provenance.sourceType, field + ".provenance.sourceType", issues);
			const sourcePath = value.provenance.sourcePath === undefined ? undefined : requiredString(value.provenance.sourcePath, field + ".provenance.sourcePath", issues);
			const retrievedAt = validTimestamp(value.provenance.retrievedAt, field + ".provenance.retrievedAt", issues);
			const metadata = value.provenance.metadata === undefined ? undefined : stringMap(value.provenance.metadata, field + ".provenance.metadata", issues);
			if (sourceType && retrievedAt) provenance = { sourceType, ...(sourcePath ? { sourcePath } : {}), retrievedAt, ...(metadata ? { metadata } : {}) };
		}
	}
	if (type && externalId) return { type, externalId, ...(provenance ? { provenance } : {}), ...(externalRevision ? { externalRevision } : {}), ...(contentHash ? { contentHash } : {}), ...(extractionMetadata ? { extractionMetadata } : {}), ...(updatedAt ? { updatedAt } : {}), ...(visibilityLabels ? { visibilityLabels } : {}), ...(managedSections ? { managedSections } : {}) };
	return undefined;
}

function stringList(value: unknown, field: string, issues: string[]): string[] | undefined {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		issues.push(field + " must be an array of non-empty strings");
		return undefined;
	}
	return [...new Set(value)];
}

function assertTombstonePolicy(value: unknown, issues: string[]): TombstonePolicy | undefined {
	if (!isRecord(value)) {
		issues.push("tombstonePolicy must be an object");
		return undefined;
	}
	if (value.mode !== "recoverable-trash") issues.push("tombstonePolicy.mode must be recoverable-trash");
	if (!Number.isInteger(value.retentionDays) || Number(value.retentionDays) < 1 || Number(value.retentionDays) > 3650) issues.push("tombstonePolicy.retentionDays must be an integer from 1 to 3650");
	if (value.deletionTimestampField !== "deletedAt") issues.push("tombstonePolicy.deletionTimestampField must be deletedAt");
	if (issues.some((issue) => issue.startsWith("tombstonePolicy."))) return undefined;
	return { mode: "recoverable-trash", retentionDays: value.retentionDays as number, deletionTimestampField: "deletedAt" };
}

function assertProtectedBranchPolicy(value: unknown, issues: string[]): ProtectedBranchPolicy | undefined {
	if (!isRecord(value)) {
		issues.push("protectedBranchPolicy must be an object");
		return undefined;
	}
	const branches = stringList(value.branches, "protectedBranchPolicy.branches", issues);
	if (!branches?.length) issues.push("protectedBranchPolicy.branches must not be empty");
	if (value.requireExpectedHead !== true) issues.push("protectedBranchPolicy.requireExpectedHead must be true");
	if (value.allowForcePush !== false) issues.push("protectedBranchPolicy.allowForcePush must be false");
	if (value.pushMode !== "explicit") issues.push("protectedBranchPolicy.pushMode must be explicit");
	if (issues.some((issue) => issue.startsWith("protectedBranchPolicy."))) return undefined;
	return { branches: branches!, requireExpectedHead: true, allowForcePush: false, pushMode: "explicit" };
}

function assertCanonicalRemote(value: unknown, issues: string[]): CanonicalRemoteConfiguration | null | undefined {
	if (value === null) return null;
	if (!isRecord(value)) {
		issues.push("canonicalRemote must be null or an object");
		return undefined;
	}
	const name = requiredString(value.name, "canonicalRemote.name", issues);
	const url = requiredString(value.url, "canonicalRemote.url", issues);
	const branch = requiredString(value.branch, "canonicalRemote.branch", issues);
	if (value.fetchMode !== "explicit") issues.push("canonicalRemote.fetchMode must be explicit");
	if (value.pushMode !== "explicit") issues.push("canonicalRemote.pushMode must be explicit");
	if (url) {
		try { const parsed = new URL(url); if (parsed.username || parsed.password) issues.push("canonicalRemote.url must not contain credentials"); }
		catch { issues.push("canonicalRemote.url must be a valid URL"); }
	}
	if (issues.some((issue) => issue.startsWith("canonicalRemote."))) return undefined;
	return { name: name!, url: url!, branch: branch!, fetchMode: "explicit", pushMode: "explicit" };
}

export function assertBrainIdentity(value: unknown, file = ".brain/identity.json"): BrainIdentityMetadata {
	const issues: string[] = [];
	if (!isRecord(value)) throw new BrainMetadataError(file, ["metadata must be an object"]);
	rejectUnknown(value, ["metadataVersion", "brainId", "repositoryId", "generatedContentOwner", "managedSectionOwner", "tombstonePolicy", "canonicalRemote", "protectedBranchPolicy"], "metadata", issues);
	if (value.metadataVersion !== 1) issues.push("metadataVersion must be 1");
	const brainId = requiredUuid(value.brainId, "brainId", issues);
	const repositoryId = requiredUuid(value.repositoryId, "repositoryId", issues);
	const generatedContentOwner = requiredString(value.generatedContentOwner, "generatedContentOwner", issues);
	const managedSectionOwner = requiredString(value.managedSectionOwner, "managedSectionOwner", issues);
	const tombstonePolicy = assertTombstonePolicy(value.tombstonePolicy, issues);
	const canonicalRemote = assertCanonicalRemote(value.canonicalRemote, issues);
	const protectedBranchPolicy = assertProtectedBranchPolicy(value.protectedBranchPolicy, issues);
	if (issues.length) throw new BrainMetadataError(file, issues);
	return { metadataVersion: 1, brainId: brainId!, repositoryId: repositoryId!, generatedContentOwner: generatedContentOwner!, managedSectionOwner: managedSectionOwner!, tombstonePolicy: tombstonePolicy!, canonicalRemote: canonicalRemote!, protectedBranchPolicy: protectedBranchPolicy! };
}

export function assertBrainSettings(value: unknown, file = ".brain/settings.json"): { schemaPack: { id: string; version: string }; sources: Record<string, { type: string; version?: string; kind?: string; trusted?: boolean }> } {
	const issues: string[] = [];
	if (!isRecord(value)) throw new BrainMetadataError(file, ["metadata must be an object"]);
	rejectUnknown(value, ["schemaPack", "sources"], "metadata", issues);
	const schemaPack = isRecord(value.schemaPack) ? value.schemaPack : undefined;
	const schemaPackId = requiredString(schemaPack?.id, "schemaPack.id", issues);
	const schemaPackVersion = requiredString(schemaPack?.version, "schemaPack.version", issues);
	if (!isRecord(value.sources)) issues.push("sources must be an object");
	const sources: Record<string, { type: string; version?: string; kind?: string; trusted?: boolean }> = {};
	if (isRecord(value.sources)) {
		for (const [id, descriptor] of Object.entries(value.sources)) {
			if (!isRecord(descriptor)) {
				issues.push("sources." + id + " must be an object");
				continue;
			}
			const type = requiredString(descriptor.type, "sources." + id + ".type", issues);
			if (descriptor.version !== undefined) requiredString(descriptor.version, "sources." + id + ".version", issues);
			if (descriptor.kind !== undefined) requiredString(descriptor.kind, "sources." + id + ".kind", issues);
			if (descriptor.trusted !== undefined && typeof descriptor.trusted !== "boolean") issues.push("sources." + id + ".trusted must be boolean");
			if (type) sources[id] = { type, ...(typeof descriptor.version === "string" ? { version: descriptor.version } : {}), ...(typeof descriptor.kind === "string" ? { kind: descriptor.kind } : {}), ...(typeof descriptor.trusted === "boolean" ? { trusted: descriptor.trusted } : {}) };
		}
	}
	if (issues.length) throw new BrainMetadataError(file, issues);
	return { schemaPack: { id: schemaPackId!, version: schemaPackVersion! }, sources };
}

export function assertBrainManifestEntry(value: unknown, file = ".brain/manifest.jsonl"): BrainManifestMetadataEntry {
	const issues: string[] = [];
	if (!isRecord(value)) throw new BrainMetadataError(file, ["manifest entry must be an object"]);
	rejectUnknown(value, ["id", "path", "contentHash", "revision", "source", "deleted", "deletedAt", "stale", "accessLabels"], "entry", issues);
	const id = requiredString(value.id, "entry.id", issues);
	const path = requiredString(value.path, "entry.path", issues);
	if (value.deleted !== undefined && typeof value.deleted !== "boolean") issues.push("entry.deleted must be boolean");
	const deleted = value.deleted as boolean | undefined;
	const trashPath = path?.startsWith(".brain/trash/") === true;
	if (path && (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..") || path === ".brain" || path.startsWith(".brain/") && !(deleted === true && trashPath))) issues.push("entry.path must be a normalized non-metadata relative path");
	const contentHash = requiredString(value.contentHash, "entry.contentHash", issues);
	const revision = requiredString(value.revision, "entry.revision", issues);
	const source = value.source === undefined ? undefined : assertSourceMetadata(value.source, "entry.source", issues);
	const deletedAt = value.deletedAt === undefined ? undefined : validTimestamp(value.deletedAt, "entry.deletedAt", issues);
	if (deleted === true && !deletedAt) issues.push("entry.deletedAt is required for deleted entries");
	if (value.stale !== undefined && typeof value.stale !== "boolean") issues.push("entry.stale must be boolean");
	const stale = value.stale as boolean | undefined;
	const accessLabels = optionalStringList(value.accessLabels, "entry.accessLabels", issues);
	if (issues.length) throw new BrainMetadataError(file, issues);
	return { id: id!, path: path!, contentHash: contentHash!, revision: revision!, ...(source ? { source } : {}), ...(deleted !== undefined ? { deleted } : {}), ...(deletedAt ? { deletedAt } : {}), ...(stale !== undefined ? { stale } : {}), ...(accessLabels ? { accessLabels } : {}) };
}
