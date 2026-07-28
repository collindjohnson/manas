import { sha256 } from "../utils";

/** The exact remote document representation used for both uploads and checkpoints. */
export function canonicalRemotePayload(input: {
	id: string;
	text: string;
	contextualPrefix: string;
	provider: string;
	role?: string | null;
	project?: string | null;
	repository?: string | null;
	workspace?: string | null;
	documentId: string;
	relativePath: string;
	sourcePath?: string | null;
	createdAt?: string | null;
	updatedAt?: string | null;
	startOffset: number;
	endOffset: number;
}): {
	id: string;
	text: string;
	metadata: Record<string, string>;
	hash: string;
} {
	const metadata: Record<string, string> = {
		chunk_id: input.id,
		document_id: input.documentId,
		provider: input.provider,
		relative_path: input.relativePath,
		source_path: input.sourcePath ?? input.relativePath,
		start_offset: String(input.startOffset),
		end_offset: String(input.endOffset),
		chunking_version: "1",
	};
	for (const [name, value] of Object.entries({
		role: input.role,
		project: input.project,
		repository: input.repository,
		workspace: input.workspace,
		created_at: input.createdAt,
		updated_at: input.updatedAt,
	}))
		if (typeof value === "string" && value) metadata[name] = value;
	const payload = {
		id: input.id,
		text: `${input.contextualPrefix}\n${input.text}`,
		metadata,
	};
	return { ...payload, hash: sha256(JSON.stringify(payload)) };
}
