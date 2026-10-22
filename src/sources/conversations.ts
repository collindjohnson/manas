import { transcriptBody } from "../utils";
import { createHash } from "node:crypto";
import type { SourceCheckpoint, SourceDescriptor } from "./types";

type ConversationLike = {
	provider: string;
	sourceId: string;
	sourcePath: string;
	updatedAt?: string;
	project?: string;
	repository?: string;
	messages: Array<{ role: "user" | "assistant"; text: string; timestamp?: string }>;
};

export class ConversationSourceAdapter {
	private completedCheckpoint: SourceCheckpoint = {};
	constructor(readonly id: string, private readonly load: () => Promise<ConversationLike[]>) {}

	describe(): SourceDescriptor {
		return { id: this.id, version: "1", kind: "conversation", trusted: true };
	}

	async *scan(checkpoint?: SourceCheckpoint) {
		let previous: Record<string, string> = {};
		if (checkpoint?.cursor) {
			try {
				const parsed = JSON.parse(checkpoint.cursor);
				if (parsed.version === 1 && parsed.items && typeof parsed.items === "object" && !Array.isArray(parsed.items)) previous = parsed.items;
			} catch { /* Reconcile an unrecognized legacy cursor by scanning all records. */ }
		}
		const items: Record<string, string> = Object.create(null);
		for (const document of await this.list()) {
			const fingerprint = createHash("sha256").update(JSON.stringify({ contentHash: document.contentHash, externalRevision: document.externalRevision, path: document.suggestedPath, sourcePath: document.provenance.sourcePath, metadata: document.provenance.metadata })).digest("hex");
			items[document.externalId] = fingerprint;
			if (previous[document.externalId] !== fingerprint) yield document;
		}
		// The synchronization layer persists this only after every yielded write succeeds.
		this.completedCheckpoint = { updatedAt: new Date().toISOString(), cursor: JSON.stringify({ version: 1, items }) };
	}

	checkpoint(): SourceCheckpoint { return { updatedAt: new Date().toISOString(), ...this.completedCheckpoint }; }

	async list() {
		return (await this.load()).map((conversation) => {
			const content = transcriptBody(conversation.messages);
			return {
			externalId: conversation.sourceId,
			suggestedPath: ["conversations", conversation.provider, `${conversation.sourceId}.md`].join(String.fromCharCode(47)),
			content,
			contentHash: createHash("sha256").update(content).digest("hex"),
			externalRevision: conversation.updatedAt,
			provenance: {
				sourceType: `conversation:${conversation.provider}`,
				sourcePath: conversation.sourcePath,
				retrievedAt: new Date().toISOString(),
				metadata: Object.fromEntries(Object.entries({ project: conversation.project, repository: conversation.repository }).filter(([, value]) => Boolean(value))) as Record<string, string>,
			},
			deleted: false,
			updatedAt: conversation.updatedAt,
		};
		});
	}
}
