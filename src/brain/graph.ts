import type { Database } from "bun:sqlite";

interface GraphDocument {
	manasId: string;
	provider: string;
	project?: string | number | boolean | null;
	repository?: string | number | boolean | null;
	workspace?: string | number | boolean | null;
	sourcePath?: string | number | boolean | null;
}

function value(input: GraphDocument["project"]): string | undefined {
	return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function nodeId(type: string, nodeValue: string): string {
	return `${type}:${nodeValue}`;
}

/** Creates only relationships explicitly recorded in archive frontmatter. */
export function replaceDocumentGraph(
	database: Database,
	document: GraphDocument,
): void {
	database
		.prepare("DELETE FROM graph_edges WHERE document_id = ?")
		.run(document.manasId);
	const source = nodeId("conversation", document.manasId);
	database
		.prepare(
			"INSERT OR IGNORE INTO graph_nodes (id, type, value) VALUES (?, ?, ?)",
		)
		.run(source, "conversation", document.manasId);
	const facts: Array<[string, string | undefined]> = [
		["provider", document.provider],
		["project", value(document.project)],
		["repository", value(document.repository)],
		["workspace", value(document.workspace)],
		["source_path", value(document.sourcePath)],
	];
	for (const [type, fact] of facts) {
		if (!fact) continue;
		const target = nodeId(type, fact);
		database
			.prepare(
				"INSERT OR IGNORE INTO graph_nodes (id, type, value) VALUES (?, ?, ?)",
			)
			.run(target, type, fact);
		database
			.prepare(
				"INSERT OR REPLACE INTO graph_edges (source_id, target_id, type, document_id, weight, provenance) VALUES (?, ?, ?, ?, 1, 'frontmatter')",
			)
			.run(source, target, type, document.manasId);
	}
}

export function graphContributions(
	database: Database,
	documentIds: string[],
): Map<
	string,
	Array<{
		type: "project" | "repository" | "workspace" | "source_path";
		sharedWith: string;
	}>
> {
	const result = new Map<
		string,
		Array<{
			type: "project" | "repository" | "workspace" | "source_path";
			sharedWith: string;
		}>
	>();
	const allowed = new Set([
		"project",
		"repository",
		"workspace",
		"source_path",
	]);
	for (const documentId of documentIds) result.set(documentId, []);
	if (documentIds.length < 2) return result;
	const placeholders = documentIds.map(() => "?").join(", ");
	const rows = database
		.prepare(
			`SELECT source.document_id AS documentId, peer.document_id AS sharedWith, source.type
		 FROM graph_edges source JOIN graph_edges peer
		 ON source.target_id = peer.target_id AND source.document_id <> peer.document_id
		 WHERE source.document_id IN (${placeholders}) AND peer.document_id IN (${placeholders})
		 ORDER BY source.document_id, source.type, peer.document_id`,
		)
		.all(...documentIds, ...documentIds) as Array<{
		documentId: string;
		sharedWith: string;
		type: string;
	}>;
	const seen = new Set<string>();
	for (const row of rows) {
		const key = `${row.documentId}\0${row.type}\0${row.sharedWith}`;
		if (!allowed.has(row.type) || seen.has(key)) continue;
		seen.add(key);
		result.get(row.documentId)?.push({
			type: row.type as
				| "project"
				| "repository"
				| "workspace"
				| "source_path",
			sharedWith: row.sharedWith,
		});
	}
	return result;
}

export function relatedDocuments(
	database: Database,
	manasId: string,
	limit = 20,
): Array<{
	manasId: string;
	path: string;
	title?: string;
	provider: string;
	score: number;
}> {
	return database
		.prepare(`SELECT d.manas_id AS manasId, d.relative_path AS path, d.title, d.provider, COUNT(*) AS score
		FROM graph_edges source JOIN graph_edges peer ON source.target_id = peer.target_id AND peer.document_id <> source.document_id
		JOIN documents d ON d.manas_id = peer.document_id
		WHERE source.document_id = ? GROUP BY d.manas_id ORDER BY score DESC, d.indexed_at DESC LIMIT ?`)
		.all(manasId, limit) as Array<{
		manasId: string;
		path: string;
		title?: string;
		provider: string;
		score: number;
	}>;
}
