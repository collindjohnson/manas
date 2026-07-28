import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import type { SourceCheckpoint, SourceDescriptor } from "./types";

const execFile = promisify(execFileCallback);

async function git(root: string, args: string[]): Promise<string> {
	return (await execFile("git", ["-C", root, ...args])).stdout.trim();
}

function stableId(root: string, commit: string): string {
	return createHash("sha256").update(`${root}\0${commit}`).digest("hex");
}

export class LinkedRepositorySourceAdapter {
	constructor(readonly root: string, readonly id = "linked-repository") {}
	private latestCommit?: string;

	describe(): SourceDescriptor { return { id: this.id, version: "1", kind: "linked-repository", trusted: true }; }

	async *scan(checkpoint?: SourceCheckpoint) {
		const documents = await this.list();
		if (!checkpoint?.cursor || checkpoint.cursor !== this.latestCommit) yield* documents;
	}

	checkpoint(): SourceCheckpoint { return { cursor: this.latestCommit, updatedAt: new Date().toISOString() }; }

	async list() {
		const path = resolve(this.root);
		const commit = await git(path, ["rev-parse", "HEAD"]);
		this.latestCommit = commit;
		let remote: string | undefined;
		try { remote = await git(path, ["remote", "get-url", "origin"]); } catch { }
		const externalId = stableId(path, commit);
		const content = `# Linked repository: ${basename(path)}\n\n- Commit: ${commit}\n${remote ? `- Remote: ${remote}\n` : ""}\nThis repository remains authoritative at its original location. This brain page is a source descriptor; it does not mirror code.\n`;
		return [{
			externalId,
			suggestedPath: `files/repositories/${basename(path)}.md`,
			content,
			contentHash: createHash("sha256").update(content).digest("hex"),
			externalRevision: commit,
			updatedAt: new Date().toISOString(),
			provenance: { sourceType: "linked-repository", sourcePath: path, retrievedAt: new Date().toISOString(), metadata: { commit, ...(remote ? { remote } : {}) } },
			deleted: false,
		}];
	}
}
