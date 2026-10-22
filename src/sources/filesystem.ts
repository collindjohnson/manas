import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import type { SourceCheckpoint } from "./types";

const acceptedExtensions = new Set([".md", ".markdown", ".txt"]);

function slashPath(path: string): string {
	return path.split(sep).join(String.fromCharCode(47));
}

function stableId(root: string, path: string): string {
	return createHash("sha256").update(`${root}\0${path}`).digest("hex");
}

function suggestedPath(path: string): string {
	const extension = extname(path).toLowerCase();
	return extension === ".txt" ? `${path.slice(0, -extension.length)}.md` : path;
}

export class FilesystemSourceAdapter {
	private completedCheckpoint: SourceCheckpoint = {};
	constructor(readonly root: string, readonly id = "filesystem") {}

	describe() {
		return { id: this.id, version: "1", kind: "filesystem", trusted: true };
	}

	async *scan(checkpoint?: SourceCheckpoint) {
		let previous: Record<string, string> = {};
		if (checkpoint?.cursor) {
			try {
				const parsed = JSON.parse(checkpoint.cursor);
				if (parsed.version === 1 && parsed.items && typeof parsed.items === "object" && !Array.isArray(parsed.items)) previous = parsed.items;
			} catch { /* Legacy timestamps and unknown cursors require full reconciliation. */ }
		}
		const items: Record<string, string> = Object.create(null);
		for (const document of await this.list()) {
			const fingerprint = createHash("sha256").update(JSON.stringify({ contentHash: document.contentHash, path: document.suggestedPath, updatedAt: document.updatedAt, sourcePath: document.provenance.sourcePath })).digest("hex");
			items[document.externalId] = fingerprint;
			if (previous[document.externalId] !== fingerprint) yield document;
		}
		this.completedCheckpoint = { updatedAt: new Date().toISOString(), cursor: JSON.stringify({ version: 1, items }) };
	}

	checkpoint(): SourceCheckpoint { return { ...this.completedCheckpoint }; }

	async list() {
		const documents: Array<{
			externalId: string;
			suggestedPath: string;
			content: string;
			provenance: { sourceType: string; sourcePath: string; retrievedAt: string };
			deleted: boolean;
			contentHash: string;
			updatedAt: string;
		}> = [];
		const visit = async (directory: string): Promise<void> => {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (entry.name.startsWith(".")) continue;
				const path = join(directory, entry.name);
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) { await visit(path); continue; }
				if (!entry.isFile() || !acceptedExtensions.has(extname(entry.name).toLowerCase())) continue;
				const info = await lstat(path);
				if (!info.isFile() || info.isSymbolicLink()) continue;
				const sourceRelative = slashPath(relative(this.root, path));
				const content = await readFile(path, "utf8");
				const markdown = extname(path).toLowerCase() === ".txt" ? "# " + basename(path) + "\n\n" + content : content;
				documents.push({
					externalId: stableId(this.root, sourceRelative),
					suggestedPath: suggestedPath(join("files", sourceRelative)),
					content: markdown,
					contentHash: createHash("sha256").update(markdown).digest("hex"),
					provenance: { sourceType: "filesystem", sourcePath: path, retrievedAt: new Date().toISOString() },
					deleted: false,
					updatedAt: info.mtime.toISOString(),
				});
			}
		};
		try { await visit(this.root); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return documents.sort((left, right) => left.suggestedPath.localeCompare(right.suggestedPath));
	}
}
