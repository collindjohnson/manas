import {
	chmod,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { ArchiveDocument, Conversation, Provider } from "./model";
import {
	archiveProvider,
	providerName,
	safeRelativePath,
	parseTimestamp,
	sanitizeTitle,
	sha256,
	transcriptBody,
	uuidv5,
} from "./utils";

export interface ArchiveScan {
	documents: ArchiveDocument[];
	bySource: Map<string, ArchiveDocument>;
	byManasId: Map<string, ArchiveDocument>;
	warnings: string[];
}

function parseScalar(value: string): string | number | boolean | null {
	const trimmed = value.trim();
	if (trimmed === "null" || trimmed === "~") return null;
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		if (trimmed.startsWith('"')) {
			try {
				return JSON.parse(trimmed) as string;
			} catch {
				return trimmed.slice(1, -1);
			}
		}
		return trimmed.slice(1, -1).replaceAll("''", "'");
	}
	return trimmed;
}

export function parseFrontmatter(
	text: string,
):
	| {
			values: Record<string, string | number | boolean | null>;
			header: string;
			body: string;
	  }
	| undefined {
	if (!text.startsWith("---\n")) return undefined;
	const end = text.indexOf("\n---", 4);
	if (end < 0) return undefined;
	const header = text.slice(0, end + 4);
	const body = text.slice(end + 4).replace(/^\n/, "");
	const values: Record<string, string | number | boolean | null> = {};
	for (const line of text.slice(4, end).split("\n")) {
		const match = line.match(/^([A-Za-z0-9_.-]+):(?:\s*)(.*)$/);
		if (match) values[match[1]] = parseScalar(match[2]);
	}
	return { values, header, body };
}

export function isHiddenArchiveEntry(name: string): boolean {
	return name.startsWith(".");
}

async function walkMarkdown(root: string): Promise<string[]> {
	const paths: string[] = [];
	async function visit(directory: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (isHiddenArchiveEntry(entry.name)) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (
				entry.isFile() &&
				entry.name.endsWith(".md") &&
				!["INDEX.md", "SYNC_REPORT.md", "EXPORT_REPORT.md"].includes(entry.name)
			)
				paths.push(path);
		}
	}
	await visit(root);
	return paths.sort();
}

function sourceKey(provider: unknown, sourceId: unknown): string | undefined {
	if (typeof sourceId !== "string" || !sourceId) return undefined;
	const normalizedProvider =
		provider === "claude_code"
			? "claude_code"
			: typeof provider === "string"
				? provider
				: undefined;
	return normalizedProvider ? `${normalizedProvider}\0${sourceId}` : undefined;
}

export async function scanArchive(root: string): Promise<ArchiveScan> {
	const documents: ArchiveDocument[] = [];
	const bySource = new Map<string, ArchiveDocument>();
	const byManasId = new Map<string, ArchiveDocument>();
	const warnings: string[] = [];
	for (const path of await walkMarkdown(root)) {
		const text = await readFile(path, "utf8");
		const parsed = parseFrontmatter(text);
		if (!parsed) {
			warnings.push(`${path}: missing or malformed frontmatter`);
			continue;
		}
		const values = parsed.values;
		const legacyId =
			typeof values.nessie_id === "string" ? values.nessie_id : undefined;
		const canonicalId =
			typeof values.manas_id === "string" ? values.manas_id : undefined;
		if (legacyId && canonicalId && legacyId !== canonicalId) {
			warnings.push(`${path}: conflicting manas_id and nessie_id`);
			continue;
		}
		const manasId =
			canonicalId ?? legacyId;
		if (!manasId) {
			warnings.push(`${path}: missing manas_id`);
			continue;
		}
		const document: ArchiveDocument = {
			path,
			provider:
				typeof values.provider === "string" ? values.provider : "unknown",
			manasId,
			sourceId:
				typeof values.source_id === "string" ? values.source_id : undefined,
			sourcePath:
				typeof values.source_path === "string" ? values.source_path : undefined,
			title: typeof values.title === "string" ? values.title : undefined,
			sourceUpdatedAt:
				typeof values.original_updated_at === "string"
					? values.original_updated_at
					: undefined,
			syncFingerprint:
				typeof values.sync_fingerprint === "string"
					? values.sync_fingerprint
					: undefined,
			frontmatter: parsed.header,
			body: parsed.body,
			bodyHash: sha256(parsed.body),
		};
		documents.push(document);
		if (byManasId.has(manasId))
			warnings.push(`duplicate manas_id: ${manasId}`);
		else byManasId.set(manasId, document);
		const key = sourceKey(values.provider, values.source_id);
		if (key) {
			if (bySource.has(key))
				warnings.push(
					`duplicate provider/source_id: ${key.replace("\0", ":")}`,
				);
			else bySource.set(key, document);
		}
	}
	return { documents, bySource, byManasId, warnings };
}

function scalar(value: string | number | boolean | null | undefined): string {
	if (value === undefined || value === null) return "null";
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function field(
	name: string,
	value: string | number | boolean | null | undefined,
): string {
	return `${name}: ${scalar(value)}`;
}

export function renderNewDocument(conversation: Conversation): {
	id: string;
	relativePath: string;
	content: string;
} {
	const id = uuidv5(`${conversation.provider}:${conversation.sourceId}`);
	const folder = archiveProvider(conversation.provider);
	const fileName = `${sanitizeTitle(conversation.title)}--${id}.md`;
	const relativePath = join(folder, fileName);
	const header = [
		"---",
		field("manas_id", id),
		field("kind", `${conversation.provider}_chat`),
		field("title", conversation.title),
		field("owner", null),
		field("owner_id", null),
		field("owner_is_current_user", true),
		field("provider", conversation.provider),
		field("provider_name", providerName(conversation.provider)),
		field("connection", null),
		field("project", conversation.project),
		field("repository", conversation.repository),
		field("repository_url", conversation.repositoryUrl),
		field("repo_key", conversation.repoKey),
		field("workspace_path", conversation.workspacePath),
		field("parent", null),
		field("source_type", "transcript"),
		field("source_id", conversation.sourceId),
		field("source_path", conversation.sourcePath),
		field("created_at", conversation.createdAt),
		field("updated_at", conversation.updatedAt),
		field("original_created_at", conversation.createdAt),
		field("original_updated_at", conversation.updatedAt),
		field("export_status", "ok"),
		field("redactions", conversation.redactions),
		field("sync_fingerprint", conversation.fingerprint),
		"---",
		"",
	].join("\n");
	return {
		id,
		relativePath,
		content: `${header}${transcriptBody(conversation.messages)}`,
	};
}

export function renderUpdatedDocument(
	existing: ArchiveDocument,
	conversation: Conversation,
): string {
	return `${existing.frontmatter}\n\n${transcriptBody(conversation.messages)}`;
}

export interface ArchiveChange {
	kind: "create" | "update" | "skip";
	provider: Provider;
	sourceId: string;
	id?: string;
	relativePath?: string;
	content?: string;
	existing?: ArchiveDocument;
}

export function planArchiveChanges(
	scan: ArchiveScan,
	conversations: Conversation[],
	root: string,
): ArchiveChange[] {
	const changes: ArchiveChange[] = [];
	const seen = new Set<string>();
	for (const conversation of conversations) {
		const key = `${conversation.provider}\0${conversation.sourceId}`;
		if (seen.has(key)) {
			changes.push({
				kind: "skip",
				provider: conversation.provider,
				sourceId: conversation.sourceId,
			});
			continue;
		}
		seen.add(key);
		const existing = scan.bySource.get(key);
		if (existing) {
			const body = `\n${transcriptBody(conversation.messages)}`;
			const currentTimestamp = parseTimestamp(conversation.updatedAt);
			const archivedTimestamp = parseTimestamp(existing.sourceUpdatedAt);
			const checkpointUnchanged = existing.syncFingerprint
				? existing.syncFingerprint === conversation.fingerprint
				: archivedTimestamp &&
					currentTimestamp &&
					currentTimestamp <= archivedTimestamp;
			if (checkpointUnchanged || sha256(body) === existing.bodyHash)
				changes.push({
					kind: "skip",
					provider: conversation.provider,
					sourceId: conversation.sourceId,
					existing,
				});
			else
				changes.push({
					kind: "update",
					provider: conversation.provider,
					sourceId: conversation.sourceId,
					relativePath: relative(root, existing.path),
					content: renderUpdatedDocument(existing, conversation),
					existing,
				});
			continue;
		}
		const rendered = renderNewDocument(conversation);
		const collision = scan.byManasId.get(rendered.id);
		if (collision) {
			changes.push({
				kind: "skip",
				provider: conversation.provider,
				sourceId: conversation.sourceId,
				id: rendered.id,
				existing: collision,
			});
			continue;
		}
		changes.push({
			kind: "create",
			provider: conversation.provider,
			sourceId: conversation.sourceId,
			id: rendered.id,
			relativePath: rendered.relativePath,
			content: rendered.content,
		});
	}
	return changes;
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
	await writeFile(temp, content, { mode: 0o600 });
	await rename(temp, path);
}

export async function applyArchiveChanges(
	root: string,
	changes: ArchiveChange[],
	dryRun: boolean,
): Promise<void> {
	if (dryRun) return;
	const applied: Array<{ path: string; previous?: Buffer }> = [];
	try {
		for (const change of changes.filter((item) => item.kind !== "skip")) {
			if (!change.relativePath || change.content === undefined) continue;
			const path = join(root, safeRelativePath(root, change.relativePath));
			let previous: Buffer | undefined;
			try {
				previous = await readFile(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await writeAtomic(path, change.content);
			applied.push({ path, previous });
		}
	} catch (error) {
		for (const item of applied.reverse()) {
			if (item.previous)
				await writeFile(item.path, item.previous, { mode: 0o600 });
			else await rm(item.path, { force: true });
		}
		throw error;
	}
}

export async function ensureArchiveRoot(root: string): Promise<void> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	await chmod(root, 0o700);
	await stat(root);
}
