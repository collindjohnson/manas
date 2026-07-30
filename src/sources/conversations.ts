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
	constructor(readonly id: string, private readonly load: () => Promise<ConversationLike[]>) {}

	describe(): SourceDescriptor {
		return { id: this.id, version: "1", kind: "conversation", trusted: true };
	}

	async *scan(checkpoint?: SourceCheckpoint) {
		for (const document of await this.list())
			if (!checkpoint?.updatedAt || !document.updatedAt || document.updatedAt > checkpoint.updatedAt) yield document;
	}

	checkpoint(): SourceCheckpoint { return { updatedAt: new Date().toISOString() }; }

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
