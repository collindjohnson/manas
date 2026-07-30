import { resolve } from "node:path";

export type ArchiveCandidateOrigin = "explicit" | "configured" | "default";

export interface ArchiveCandidate {
	path: string;
	origin: ArchiveCandidateOrigin;
}

export function selectArchiveCandidate(
	explicitArchive: string | undefined,
	configuredArchive: string | undefined,
	defaultArchive: string,
): ArchiveCandidate {
	if (explicitArchive !== undefined) return { path: resolve(explicitArchive), origin: "explicit" };
	if (configuredArchive !== undefined) return { path: resolve(configuredArchive), origin: "configured" };
	return { path: resolve(defaultArchive), origin: "default" };
}
