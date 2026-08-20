export const BRAIN_SCHEMA_VERSION = 9;
const pathSeparator = String.fromCharCode(47);

export interface SchemaPack {
	id: string;
	version: string;
	pathTypes: Record<string, string>;
}

export interface SchemaUpgradePlan {
	from: { id: string; version: string };
	to: { id: string; version: string };
	added: string[];
	removed: string[];
	changed: Array<{ prefix: string; from: string; to: string }>;
	compatible: boolean;
	requiresMigration: boolean;
}

export const DEFAULT_SCHEMA_PACK: SchemaPack = {
	id: "default",
	version: "1",
	pathTypes: {
		[`people${pathSeparator}`]: "person",
		[`organizations${pathSeparator}`]: "organization",
		[`meetings${pathSeparator}`]: "meeting",
		[`email${pathSeparator}`]: "email",
		[`conversations${pathSeparator}`]: "conversation",
		[`inbox${pathSeparator}`]: "inbox",
		[`notes${pathSeparator}`]: "note",
		[`files${pathSeparator}`]: "file",
	},
};

export const LEGACY_SCHEMA_PACK: SchemaPack = {
	id: "legacy",
	version: "1",
	pathTypes: {
		[`contacts${pathSeparator}`]: "person",
		[`companies${pathSeparator}`]: "organization",
		[`calendar${pathSeparator}`]: "meeting",
		[`mail${pathSeparator}`]: "email",
		[`chats${pathSeparator}`]: "conversation",
		[`ideas${pathSeparator}`]: "note",
		[`attachments${pathSeparator}`]: "file",
	},
};

export const BUNDLED_SCHEMA_PACKS: readonly SchemaPack[] = [DEFAULT_SCHEMA_PACK, LEGACY_SCHEMA_PACK];

function validIdentifier(value: string, allowed: string): boolean {
	if (!value || value.length > 64) return false;
	const first = value.charCodeAt(0);
	if (!((first >= 48 && first <= 57) || (first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return false;
	return [...value].every((character) => allowed.includes(character.toLowerCase()));
}

export function assertSchemaPack(pack: SchemaPack): SchemaPack {
	if (!pack || !validIdentifier(pack.id, "abcdefghijklmnopqrstuvwxyz0123456789_-") || !validIdentifier(pack.version, "abcdefghijklmnopqrstuvwxyz0123456789_.-") || !pack.pathTypes || typeof pack.pathTypes !== "object") throw new Error("invalid schema pack");
	const pathTypes: Record<string, string> = {};
	for (const [prefix, type] of Object.entries(pack.pathTypes)) {
		if (!prefix || prefix.includes("\\") || prefix.startsWith(pathSeparator) || prefix.split(pathSeparator).includes("..") || !prefix.endsWith(pathSeparator) || typeof type !== "string" || !type.trim()) throw new Error("invalid schema pack");
		pathTypes[prefix] = type.trim();
	}
	return { id: pack.id, version: pack.version, pathTypes };
}

export function bundledSchemaPack(id: string, version: string): SchemaPack | undefined {
	return BUNDLED_SCHEMA_PACKS.find((pack) => pack.id === id && pack.version === version);
}

export function detectSchemaPack(paths: Iterable<string>, packs: readonly SchemaPack[] = BUNDLED_SCHEMA_PACKS): { pack: SchemaPack; matchedPaths: number; score: number }[] {
	return packs.map(assertSchemaPack).map((pack) => {
		let matchedPaths = 0;
		for (const path of paths) if (inferSchemaType(path, pack)) matchedPaths += 1;
		return { pack, matchedPaths, score: matchedPaths };
	}).filter((candidate) => candidate.matchedPaths > 0).sort((left, right) => right.score - left.score || left.pack.id.localeCompare(right.pack.id) || left.pack.version.localeCompare(right.pack.version));
}

export function inferSchemaType(path: string, pack: SchemaPack = DEFAULT_SCHEMA_PACK): string | undefined {
	const normalized = path.replaceAll("\\", pathSeparator);
	if (!normalized || normalized.startsWith(pathSeparator) || normalized.split(pathSeparator).includes("..")) throw new Error("invalid schema path");
	return Object.entries(pack.pathTypes).sort((left, right) => right[0].length - left[0].length).find(([prefix]) => normalized.startsWith(prefix))?.[1];
}

export function planSchemaUpgrade(from: SchemaPack, to: SchemaPack): SchemaUpgradePlan {
	const current = assertSchemaPack(from);
	const next = assertSchemaPack(to);
	const added = Object.keys(next.pathTypes).filter((prefix) => !(prefix in current.pathTypes)).sort();
	const removed = Object.keys(current.pathTypes).filter((prefix) => !(prefix in next.pathTypes)).sort();
	const changed = Object.keys(current.pathTypes).filter((prefix) => prefix in next.pathTypes && current.pathTypes[prefix] !== next.pathTypes[prefix]).sort().map((prefix) => ({ prefix, from: current.pathTypes[prefix]!, to: next.pathTypes[prefix]! }));
	return { from: { id: current.id, version: current.version }, to: { id: next.id, version: next.version }, added, removed, changed, compatible: changed.length === 0 && removed.length === 0, requiresMigration: changed.length > 0 || removed.length > 0 };
}

export function assertSchemaActivationPreservesBytes(plan: SchemaUpgradePlan): void {
	if (plan.from.id === plan.to.id && plan.from.version === plan.to.version) return;
	if (!plan.compatible && plan.requiresMigration) throw new Error("schema activation requires an explicitly approved migration");
}
export const SELECT_SCHEMA_VERSION =
	"SELECT value FROM schema_meta WHERE key = 'schema_version'";
export const UPSERT_SCHEMA_VERSION =
	"INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)";
export const INTEGRITY_CHECK = "PRAGMA integrity_check";
export const DATABASE_PRAGMAS =
	"PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;";
export const SELECT_DOCUMENT_HASH =
	"SELECT body_hash FROM documents WHERE manas_id = ?";
export const SELECT_DOCUMENT_IDS = "SELECT manas_id FROM documents";
export const DELETE_DOCUMENT = "DELETE FROM documents WHERE manas_id = ?";
export const INSERT_DOCUMENT =
	"INSERT INTO documents (manas_id, relative_path, provider, kind, source_id, source_path, title, project, repository, workspace, created_at, updated_at, frontmatter_hash, body_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
export const INSERT_CHUNK =
	"INSERT INTO chunks (id, document_id, ordinal, role, start_offset, end_offset, text, text_hash, contextual_prefix, size_estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
export const INSERT_FTS =
	"INSERT INTO chunks_fts (chunk_id, text, title, project, repository, provider) VALUES (?, ?, ?, ?, ?, ?)";
export const SEARCH_FTS =
	"SELECT c.id AS chunk_id, c.text, d.manas_id, d.relative_path, d.title, d.provider, d.project, d.repository, d.workspace, c.role, d.created_at, d.updated_at, bm25(chunks_fts) AS rank FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.chunk_id JOIN documents d ON d.manas_id = c.document_id WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?";

export const BRAIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (
  manas_id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
  kind TEXT, source_id TEXT, source_path TEXT, title TEXT, project TEXT, repository TEXT, workspace TEXT,
  created_at TEXT, updated_at TEXT, frontmatter_hash TEXT NOT NULL, body_hash TEXT NOT NULL, indexed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(manas_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, role TEXT, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
  text TEXT NOT NULL, text_hash TEXT NOT NULL, contextual_prefix TEXT NOT NULL, size_estimate INTEGER NOT NULL,
  UNIQUE(document_id, ordinal)
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, text, title, project, repository, provider);
CREATE TABLE IF NOT EXISTS local_chunk_embeddings (
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  model_fingerprint TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(chunk_id, model_fingerprint)
);
CREATE INDEX IF NOT EXISTS local_chunk_embeddings_model ON local_chunk_embeddings(model_fingerprint, dimensions);
CREATE TABLE IF NOT EXISTS remote_chunks (
  chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE, collection_name TEXT NOT NULL,
  content_hash TEXT NOT NULL, status TEXT NOT NULL, last_upserted_at TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS remote_deletions (chunk_id TEXT PRIMARY KEY, collection_name TEXT NOT NULL, requested_at TEXT NOT NULL, last_error TEXT);
-- These tables deliberately do not reference chunks: a document replacement may retain
-- an ID, and checkpoints must survive the short delete/reinsert local transaction.
CREATE TABLE IF NOT EXISTS remote_chunk_checkpoints (
  collection_name TEXT NOT NULL, chunk_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'uploaded', 'indexed', 'failed')),
  last_upserted_at TEXT, last_checked_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT, last_error TEXT, PRIMARY KEY(collection_name, chunk_id)
);
CREATE TABLE IF NOT EXISTS remote_tombstones (
  collection_name TEXT NOT NULL, chunk_id TEXT NOT NULL, requested_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, last_error TEXT,
  PRIMARY KEY(collection_name, chunk_id)
);
CREATE TABLE IF NOT EXISTS graph_nodes (id TEXT PRIMARY KEY, type TEXT NOT NULL, value TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS graph_edges (source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL, document_id TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, provenance TEXT NOT NULL, PRIMARY KEY(source_id, target_id, type, document_id));
CREATE TABLE IF NOT EXISTS index_runs (id INTEGER PRIMARY KEY, mode TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, documents_indexed INTEGER NOT NULL DEFAULT 0, chunks_indexed INTEGER NOT NULL DEFAULT 0, model TEXT, status TEXT NOT NULL, summary TEXT, local_status TEXT, remote_status TEXT, collection_name TEXT, documents_scanned INTEGER NOT NULL DEFAULT 0, remote_pending INTEGER NOT NULL DEFAULT 0);
`;
