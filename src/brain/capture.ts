import { createHash } from "node:crypto";

type Repository = {
	getPage(path: string): Promise<{ id: string; path: string; revision: string; content: string } | undefined>;
	putPage(path: string, content: string, expectedRevision?: string): Promise<{ id: string; path: string; revision: string; content: string; commit: string }>;
	getSettings?(): Promise<{ schemaPack?: { id: string; version: string } }>;
};

function dateSlug(now: Date): string {
	return now.toISOString().slice(0, 10);
}

export async function captureBrainNote(repository: Repository, content: string, now = new Date()): Promise<{ id: string; path: string; revision: string; content: string; commit?: string; created: boolean; schemaPack?: { id: string; version: string } }> {
	const trimmed = content.trim();
	if (!trimmed) throw new Error("capture content must not be empty");
	const suffix = createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
	const path = `inbox/${dateSlug(now)}-${suffix}.md`;
	const existing = await repository.getPage(path);
	const schemaPack = (await repository.getSettings?.())?.schemaPack;
	if (existing) return { ...existing, created: false, ...(schemaPack ? { schemaPack } : {}) };
	return { ...(await repository.putPage(path, `${trimmed}\n`)), created: true, ...(schemaPack ? { schemaPack } : {}) };
}
