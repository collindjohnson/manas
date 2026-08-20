import type { ArchiveDocument, BrainChunk } from "../model";
import { sha256 } from "../utils";

export const CHUNKING_VERSION = 1;

export interface ChunkingOptions {
	targetChars: number;
	maxChars: number;
}

function splitOversized(text: string, maxChars: number): string[] {
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > maxChars) {
		const candidates = ["\n\n", "\n", ". ", " "];
		let boundary = -1;
		for (const separator of candidates) {
			const found = remaining.lastIndexOf(separator, maxChars);
			if (found > maxChars / 2) {
				boundary = found + separator.length;
				break;
			}
		}
		if (boundary < 1) boundary = maxChars;
		chunks.push(remaining.slice(0, boundary).trim());
		remaining = remaining.slice(boundary).trimStart();
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

export function chunkDocument(
	document: ArchiveDocument,
	options: ChunkingOptions,
): BrainChunk[] {
	if (!document.body.trim()) return [];
	const prefix = [document.title, document.provider]
		.filter(Boolean)
		.join(" · ");
	const source = document.body.trim();
	const pieces = source
		.split(/\n\n(?=(?:user|assistant): )/)
		.flatMap((part) => splitOversized(part, options.maxChars));
	const grouped: string[] = [];
	let current = "";
	for (const piece of pieces) {
		if (current && current.length + piece.length + 2 > options.targetChars) {
			grouped.push(current);
			current = "";
		}
		current = current ? `${current}\n\n${piece}` : piece;
	}
	if (current) grouped.push(current);
	let cursor = 0;
	return grouped.map((text, ordinal) => {
		const startOffset = source.indexOf(text, cursor);
		const safeStart = startOffset < 0 ? cursor : startOffset;
		cursor = safeStart + text.length;
		const roleMatch = text.match(/^(user|assistant): /);
		const role = roleMatch?.[1] as BrainChunk["role"];
		const textHash = sha256(text);
		return {
			id: sha256(
				`${document.manasId}:${ordinal}:${textHash}:${CHUNKING_VERSION}`,
			),
			documentId: document.manasId,
			ordinal,
			role,
			startOffset: safeStart,
			endOffset: safeStart + text.length,
			text,
			textHash,
			contextualPrefix: prefix,
			sizeEstimate: text.length,
		};
	});
}
