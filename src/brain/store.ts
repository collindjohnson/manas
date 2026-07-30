import { PGlite, type Extension, type PGliteOptions } from "@electric-sql/pglite";
import pgliteDataPath from "@manas-pglite-assets/pglite.data" with { type: "file" };
import pgliteWasmPath from "@manas-pglite-assets/pglite.wasm" with { type: "file" };
import initdbWasmPath from "@manas-pglite-assets/initdb.wasm" with { type: "file" };
import vectorBundlePath from "@manas-pgvector-assets/vector.tar.gz" with { type: "file" };
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDatabaseMigrations, sqlMigration, type DatabaseMigration } from "./migrations";

export type SqlValue = string | number | boolean | null | Uint8Array;

export interface BrainStore {
	query<T extends Record<string, unknown>>(sql: string, parameters?: SqlValue[]): Promise<T[]>;
	exec(sql: string): Promise<void>;
	transaction<T>(action: (store: BrainStore) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

const vector: Extension = {
	name: "vector",
	async setup(_pg, emscriptenOpts) { return { emscriptenOpts, bundlePath: new URL(await materializeVectorBundle(), "file:") }; },
};

let pgliteAssets: Promise<Pick<PGliteOptions, "pgliteWasmModule" | "initdbWasmModule" | "fsBundle">> | undefined;
let vectorBundle: Promise<string> | undefined;

function materializeVectorBundle(): Promise<string> {
	vectorBundle ??= (async () => {
		const path = join(tmpdir(), `manas-pgvector-${process.pid}.tar.gz`);
		await Bun.write(path, Bun.file(vectorBundlePath));
		return path;
	})();
	return vectorBundle;
}

async function pgliteOptions(): Promise<Pick<PGliteOptions, "pgliteWasmModule" | "initdbWasmModule" | "fsBundle" | "extensions">> {
	pgliteAssets ??= Promise.all([
		Bun.file(pgliteWasmPath).arrayBuffer().then((bytes) => WebAssembly.compile(bytes)),
		Bun.file(initdbWasmPath).arrayBuffer().then((bytes) => WebAssembly.compile(bytes)),
	]).then(([pgliteWasmModule, initdbWasmModule]) => ({ pgliteWasmModule, initdbWasmModule, fsBundle: Bun.file(pgliteDataPath) }));
	return { extensions: { vector }, ...await pgliteAssets };
}

export class SerializedBrainStore implements BrainStore {
	private queue = Promise.resolve();
	constructor(private readonly store: BrainStore) {}

	private async serialized<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.queue;
		let release!: () => void;
		this.queue = new Promise<void>((done) => { release = done; });
		await previous;
		try { return await action(); } finally { release(); }
	}

	query<T extends Record<string, unknown>>(sql: string, parameters?: SqlValue[]): Promise<T[]> {
		return this.serialized(() => this.store.query<T>(sql, parameters));
	}

	exec(sql: string): Promise<void> {
		return this.serialized(() => this.store.exec(sql));
	}

	transaction<T>(action: (store: BrainStore) => Promise<T>): Promise<T> {
		return this.serialized(() => this.store.transaction(action));
	}

	close(): Promise<void> {
		return this.serialized(() => this.store.close());
	}
}

export const BRAIN_STORE_SCHEMA_VERSION = 24;


export const BRAIN_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS brain_schema_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE IF NOT EXISTS brain_documents (
  id text PRIMARY KEY,
  path text NOT NULL,
  content_hash text NOT NULL,
  revision text NOT NULL,
  source_type text,
  external_id text,
  deleted_at timestamptz,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE brain_documents ADD COLUMN IF NOT EXISTS brain_id text NOT NULL DEFAULT 'local';
ALTER TABLE brain_documents ADD COLUMN IF NOT EXISTS repository_id text NOT NULL DEFAULT 'local';
ALTER TABLE brain_documents ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'local';
ALTER TABLE brain_documents ADD COLUMN IF NOT EXISTS projected_commit text;
ALTER TABLE brain_documents ADD COLUMN IF NOT EXISTS access_labels jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE brain_documents ADD COLUMN IF NOT EXISTS source_updated_at timestamptz;
ALTER TABLE brain_documents ADD COLUMN IF NOT EXISTS stale boolean NOT NULL DEFAULT false;
ALTER TABLE brain_documents ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE brain_documents DROP CONSTRAINT IF EXISTS brain_documents_path_key;
CREATE INDEX IF NOT EXISTS brain_documents_scope_path ON brain_documents (brain_id, path);
CREATE INDEX IF NOT EXISTS brain_documents_tenant_scope_path ON brain_documents (tenant_id, brain_id, path);
CREATE INDEX IF NOT EXISTS brain_documents_source_health ON brain_documents (tenant_id, brain_id, source_type, stale);
CREATE TABLE IF NOT EXISTS brain_chunks (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES brain_documents(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  text text NOT NULL,
  search_vector tsvector NOT NULL,
  embedding_model text,
  embedding vector,
  UNIQUE(document_id, ordinal)
);
ALTER TABLE brain_chunks ADD COLUMN IF NOT EXISTS start_offset integer NOT NULL DEFAULT 0;
ALTER TABLE brain_chunks ADD COLUMN IF NOT EXISTS end_offset integer NOT NULL DEFAULT 0;
ALTER TABLE brain_chunks ADD COLUMN IF NOT EXISTS text_hash text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS brain_chunks_search_gin ON brain_chunks USING gin(search_vector);
CREATE TABLE IF NOT EXISTS brain_operational_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brain_projection_runs (
  id text PRIMARY KEY,
  brain_id text NOT NULL,
  repository_id text NOT NULL,
  git_commit text NOT NULL,
  status text NOT NULL CHECK(status IN ('running', 'complete', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(brain_id, git_commit)
);
ALTER TABLE brain_projection_runs ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'local';
CREATE INDEX IF NOT EXISTS brain_projection_runs_tenant_scope ON brain_projection_runs (tenant_id, brain_id, started_at DESC);
CREATE TABLE IF NOT EXISTS brain_jobs (
  id text PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'failed', 'cancelled')),
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  worker_id text,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
ALTER TABLE brain_jobs ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'local';
ALTER TABLE brain_jobs ADD COLUMN IF NOT EXISTS dependency_ids jsonb NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS brain_jobs_claimable ON brain_jobs (status, available_at, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS brain_jobs_tenant_claimable ON brain_jobs (tenant_id, status, available_at, priority DESC, created_at);
CREATE TABLE IF NOT EXISTS brain_job_schedules (
  id text PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT 'local',
  type text NOT NULL,
  payload jsonb NOT NULL,
  interval_seconds integer NOT NULL CHECK(interval_seconds > 0),
  next_run_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brain_job_schedules_due ON brain_job_schedules (tenant_id, enabled, next_run_at);
CREATE TABLE IF NOT EXISTS brain_access_tokens (
  id text PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT 'local',
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brain_access_tokens_active ON brain_access_tokens (tenant_id, revoked_at, expires_at);
CREATE TABLE IF NOT EXISTS brain_audit_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT 'local',
  action text NOT NULL,
  subject_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brain_audit_events_tenant_time ON brain_audit_events (tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS brain_links (
  tenant_id text NOT NULL DEFAULT 'local',
  brain_id text NOT NULL,
  source_document_id text NOT NULL REFERENCES brain_documents(id) ON DELETE CASCADE,
  target_path text NOT NULL,
  PRIMARY KEY (tenant_id, brain_id, source_document_id, target_path)
);
CREATE INDEX IF NOT EXISTS brain_links_target ON brain_links (tenant_id, brain_id, target_path);
`;

export const BRAIN_STORE_INCREMENTAL_PROJECTION_SCHEMA = "CREATE TABLE IF NOT EXISTS brain_active_projection_runs (\n" +
	"  tenant_id text NOT NULL,\n" +
	"  brain_id text NOT NULL,\n" +
	"  run_id text NOT NULL,\n" +
	"  git_commit text NOT NULL,\n" +
	"  updated_at timestamptz NOT NULL DEFAULT now(),\n" +
	"  PRIMARY KEY (tenant_id, brain_id)\n" +
	");\n" +
	"CREATE TABLE IF NOT EXISTS brain_document_revisions (\n" +
	"  id text PRIMARY KEY,\n" +
	"  document_id text NOT NULL,\n" +
	"  tenant_id text NOT NULL,\n" +
	"  brain_id text NOT NULL,\n" +
	"  revision text NOT NULL,\n" +
	"  path text NOT NULL,\n" +
	"  content_hash text NOT NULL,\n" +
	"  projected_commit text NOT NULL,\n" +
	"  deleted boolean NOT NULL DEFAULT false,\n" +
	"  created_at timestamptz NOT NULL DEFAULT now(),\n" +
	"  UNIQUE (document_id, revision)\n" +
	");\n" +
	"CREATE INDEX IF NOT EXISTS brain_document_revisions_scope ON brain_document_revisions (tenant_id, brain_id, document_id, created_at DESC);\n";

export const BRAIN_STORE_IDENTITY_SCHEMA = "CREATE TABLE IF NOT EXISTS brain_users (\n" +
	"  id text PRIMARY KEY,\n" +
	"  created_at timestamptz NOT NULL DEFAULT now()\n" +
	");\n" +
	"CREATE TABLE IF NOT EXISTS brain_tenants (\n" +
	"  id text PRIMARY KEY,\n" +
	"  name text NOT NULL,\n" +
	"  created_at timestamptz NOT NULL DEFAULT now()\n" +
	");\n" +
	"CREATE TABLE IF NOT EXISTS brain_identities (\n" +
	"  id text PRIMARY KEY,\n" +
	"  user_id text NOT NULL REFERENCES brain_users(id) ON DELETE CASCADE,\n" +
	"  provider text NOT NULL,\n" +
	"  subject text NOT NULL,\n" +
	"  UNIQUE(provider, subject)\n" +
	");\n" +
	"CREATE TABLE IF NOT EXISTS brain_memberships (\n" +
	"  user_id text NOT NULL REFERENCES brain_users(id) ON DELETE CASCADE,\n" +
	"  tenant_id text NOT NULL REFERENCES brain_tenants(id) ON DELETE CASCADE,\n" +
	"  role text NOT NULL CHECK(role IN ('member', 'admin', 'owner')),\n" +
	"  visibility_labels jsonb NOT NULL DEFAULT '[]'::jsonb,\n" +
	"  PRIMARY KEY(user_id, tenant_id)\n" +
	");\n" +
	"CREATE TABLE IF NOT EXISTS brain_registry (\n" +
	"  id text PRIMARY KEY,\n" +
	"  tenant_id text NOT NULL REFERENCES brain_tenants(id) ON DELETE CASCADE,\n" +
	"  name text NOT NULL,\n" +
	"  canonical_remote text,\n" +
	"  UNIQUE(tenant_id, name)\n" +
	");\n" +
	"CREATE TABLE IF NOT EXISTS brain_members (\n" +
	"  user_id text NOT NULL REFERENCES brain_users(id) ON DELETE CASCADE,\n" +
	"  tenant_id text NOT NULL,\n" +
	"  brain_id text NOT NULL REFERENCES brain_registry(id) ON DELETE CASCADE,\n" +
	"  role text NOT NULL CHECK(role IN ('member', 'admin', 'owner')),\n" +
	"  visibility_labels jsonb NOT NULL DEFAULT '[]'::jsonb,\n" +
	"  PRIMARY KEY(user_id, brain_id),\n" +
	"  FOREIGN KEY(tenant_id) REFERENCES brain_tenants(id) ON DELETE CASCADE\n" +
	");\n" +
	"CREATE TABLE IF NOT EXISTS brain_model_descriptors (\n" +
	"  id text PRIMARY KEY,\n" +
	"  tenant_id text NOT NULL,\n" +
	"  brain_id text NOT NULL,\n" +
	"  kind text NOT NULL,\n" +
	"  fingerprint text NOT NULL,\n" +
	"  descriptor jsonb NOT NULL,\n" +
	"  active boolean NOT NULL DEFAULT false,\n" +
	"  UNIQUE(tenant_id, brain_id, kind, fingerprint)\n" +
	");\n" +
	"CREATE TABLE IF NOT EXISTS brain_ingestion_runs (\n" +
	"  id text PRIMARY KEY,\n" +
	"  tenant_id text NOT NULL,\n" +
	"  brain_id text NOT NULL,\n" +
	"  source_id text NOT NULL,\n" +
	"  status text NOT NULL CHECK(status IN ('running', 'complete', 'failed', 'quarantined')),\n" +
	"  checkpoint jsonb,\n" +
	"  started_at timestamptz NOT NULL DEFAULT now(),\n" +
	"  completed_at timestamptz\n" +
");\n";

export const BRAIN_STORE_QUEUE_SCHEMA = "ALTER TABLE brain_jobs ADD COLUMN IF NOT EXISTS dead_lettered boolean NOT NULL DEFAULT false;\n" +
	"ALTER TABLE brain_jobs ADD COLUMN IF NOT EXISTS progress jsonb NOT NULL DEFAULT '{}'::jsonb;\n" +
	"CREATE TABLE IF NOT EXISTS brain_job_events (\n" +
	"  id text PRIMARY KEY,\n" +
	"  tenant_id text NOT NULL,\n" +
	"  job_id text NOT NULL,\n" +
	"  event_type text NOT NULL,\n" +
	"  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,\n" +
	"  created_at timestamptz NOT NULL DEFAULT now()\n" +
");\n" +
	"CREATE INDEX IF NOT EXISTS brain_job_events_scope ON brain_job_events (tenant_id, job_id, created_at);\n" +
	"CREATE TABLE IF NOT EXISTS brain_job_attachments (\n" +
	"  id text PRIMARY KEY,\n" +
	"  tenant_id text NOT NULL,\n" +
	"  job_id text NOT NULL,\n" +
	"  name text NOT NULL,\n" +
	"  content_hash text NOT NULL,\n" +
	"  byte_count bigint NOT NULL CHECK(byte_count >= 0),\n" +
	"  created_at timestamptz NOT NULL DEFAULT now(),\n" +
	"  UNIQUE(tenant_id, job_id, name)\n" +
");\n";

export const BRAIN_STORE_SCHEDULER_SCHEMA = "CREATE TABLE IF NOT EXISTS brain_scheduler_leases (\n" +
	"  tenant_id text PRIMARY KEY,\n" +
	"  owner_id text NOT NULL,\n" +
	"  lease_expires_at timestamptz NOT NULL,\n" +
	"  updated_at timestamptz NOT NULL DEFAULT now()\n" +
");\n";

export const BRAIN_STORE_CONTROL_PLANE_SCHEMA = `
CREATE TABLE IF NOT EXISTS brain_groups (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES brain_tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, name)
);
CREATE TABLE IF NOT EXISTS brain_group_members (
  group_id text NOT NULL REFERENCES brain_groups(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES brain_users(id) ON DELETE CASCADE,
  PRIMARY KEY(group_id, user_id)
);
CREATE TABLE IF NOT EXISTS brain_visibility_grants (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  subject_type text NOT NULL CHECK(subject_type IN ('user', 'group', 'tenant')),
  subject_id text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, brain_id, subject_type, subject_id, label)
);
CREATE TABLE IF NOT EXISTS brain_source_registrations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  version text NOT NULL,
  kind text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  compatibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  health jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, brain_id, id)
);
CREATE TABLE IF NOT EXISTS brain_oauth_clients (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  name text NOT NULL,
  public_client boolean NOT NULL DEFAULT true,
  redirect_uris jsonb NOT NULL,
  scopes jsonb NOT NULL,
  client_secret_hash text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brain_web_sessions (
  id text PRIMARY KEY,
  session_hash text NOT NULL UNIQUE,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  csrf_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS brain_oauth_authorization_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL,
  tenant_id text NOT NULL,
  subject text NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  scopes jsonb NOT NULL,
  brain_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz
);
CREATE TABLE IF NOT EXISTS brain_oauth_tokens (
  token_hash text PRIMARY KEY,
  token_kind text NOT NULL CHECK(token_kind IN ('access', 'refresh')),
  subject text NOT NULL,
  tenant_id text NOT NULL,
  brain_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  scopes jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by text
);
CREATE TABLE IF NOT EXISTS brain_quota_usage (
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  brain_id text NOT NULL DEFAULT 'local',
  operation text NOT NULL,
  window_start timestamptz NOT NULL,
  units bigint NOT NULL DEFAULT 0 CHECK(units >= 0),
  PRIMARY KEY(tenant_id, principal_id, brain_id, operation, window_start)
);
CREATE TABLE IF NOT EXISTS brain_agent_runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  agent text NOT NULL,
  operation text NOT NULL,
  base_commit text NOT NULL,
  authority text NOT NULL,
  budget jsonb NOT NULL,
  planned_paths jsonb NOT NULL,
  status text NOT NULL,
  proposal jsonb,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brain_rollback_receipts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  run_id text,
  target_kind text NOT NULL,
  target_id text NOT NULL,
  rollback_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS brain_schema_upgrade_plans (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  from_version text NOT NULL,
  to_version text NOT NULL,
  status text NOT NULL CHECK(status IN ('planned', 'approved', 'applied', 'rolled_back', 'rejected')),
  changes jsonb NOT NULL,
  approval jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brain_migration_drills (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  stage text NOT NULL,
  status text NOT NULL CHECK(status IN ('planned', 'running', 'passed', 'failed')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS brain_projection_documents (
  run_id text NOT NULL,
  document_id text NOT NULL,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  repository_id text NOT NULL,
  path text NOT NULL,
  content_hash text NOT NULL,
  revision text NOT NULL,
  source_type text,
  external_id text,
  access_labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_updated_at timestamptz,
  stale boolean NOT NULL DEFAULT false,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY(run_id, document_id)
);
CREATE TABLE IF NOT EXISTS brain_projection_chunks (
  run_id text NOT NULL,
  document_id text NOT NULL,
  id text NOT NULL,
  ordinal integer NOT NULL,
  text text NOT NULL,
  start_offset integer NOT NULL,
  end_offset integer NOT NULL,
  text_hash text NOT NULL,
  PRIMARY KEY(run_id, id)
);
CREATE TABLE IF NOT EXISTS brain_projection_links (
  run_id text NOT NULL,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  source_document_id text NOT NULL,
  target_path text NOT NULL,
  PRIMARY KEY(run_id, source_document_id, target_path)
);
ALTER TABLE brain_jobs ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS brain_jobs_tenant_idempotency ON brain_jobs (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

export const BRAIN_STORE_ANALYTICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS brain_repository_snapshots (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  repository_id text NOT NULL,
  git_commit text NOT NULL,
  manifest_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, brain_id, git_commit)
);
CREATE TABLE IF NOT EXISTS brain_graph_nodes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  node_type text NOT NULL,
  external_id text NOT NULL,
  label text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, brain_id, node_type, external_id)
);
CREATE TABLE IF NOT EXISTS brain_graph_edges (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  from_node_id text NOT NULL,
  to_node_id text NOT NULL,
  edge_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, brain_id, from_node_id, to_node_id, edge_type)
);
CREATE TABLE IF NOT EXISTS brain_facts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  subject text NOT NULL,
  predicate text NOT NULL,
  object_value text NOT NULL,
  document_id text,
  chunk_id text,
  confidence double precision NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  valid_from timestamptz,
  valid_to timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brain_claims (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  fact_id text,
  claim text NOT NULL,
  status text NOT NULL CHECK(status IN ('active', 'retracted', 'superseded')),
  confidence double precision NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  document_id text,
  chunk_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brain_timelines (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  subject text NOT NULL,
  event_at timestamptz NOT NULL,
  label text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brain_source_failures (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  source_id text NOT NULL,
  ingestion_run_id text,
  status text NOT NULL CHECK(status IN ('retryable', 'quarantined', 'failed')),
  reason text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brain_embedding_coverage (
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  model_fingerprint text NOT NULL,
  total_chunks integer NOT NULL CHECK(total_chunks >= 0),
  covered_chunks integer NOT NULL CHECK(covered_chunks >= 0 AND covered_chunks <= total_chunks),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, brain_id, model_fingerprint)
);
CREATE TABLE IF NOT EXISTS brain_cache_entries (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  cache_key text NOT NULL,
  projected_commit text NOT NULL,
  schema_version text NOT NULL,
  model_fingerprint text NOT NULL,
  value jsonb NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, brain_id, cache_key, projected_commit, schema_version, model_fingerprint)
);
CREATE INDEX IF NOT EXISTS brain_graph_edges_scope ON brain_graph_edges (tenant_id, brain_id, from_node_id, edge_type);
CREATE INDEX IF NOT EXISTS brain_facts_scope ON brain_facts (tenant_id, brain_id, subject, predicate);
CREATE INDEX IF NOT EXISTS brain_claims_scope ON brain_claims (tenant_id, brain_id, status);
CREATE INDEX IF NOT EXISTS brain_timelines_scope ON brain_timelines (tenant_id, brain_id, subject, event_at);
CREATE INDEX IF NOT EXISTS brain_source_failures_scope ON brain_source_failures (tenant_id, brain_id, source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS brain_cache_entries_scope ON brain_cache_entries (tenant_id, brain_id, cache_key, expires_at);
`;

export const BRAIN_STORE_EMBEDDING_REPLACEMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS brain_chunk_embeddings (
  chunk_id text NOT NULL REFERENCES brain_chunks(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  model_fingerprint text NOT NULL,
  dimensions integer NOT NULL CHECK(dimensions > 0),
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chunk_id, model_fingerprint)
);
CREATE INDEX IF NOT EXISTS brain_chunk_embeddings_scope ON brain_chunk_embeddings (tenant_id, brain_id, model_fingerprint);
INSERT INTO brain_chunk_embeddings (chunk_id, tenant_id, brain_id, model_fingerprint, dimensions, embedding)
SELECT c.id, d.tenant_id, d.brain_id, c.embedding_model, vector_dims(c.embedding), c.embedding
FROM brain_chunks c JOIN brain_documents d ON d.id = c.document_id
WHERE c.embedding IS NOT NULL AND c.embedding_model IS NOT NULL
ON CONFLICT (chunk_id, model_fingerprint) DO NOTHING;
`;

export const BRAIN_STORE_EMBEDDING_SCOPE_SCHEMA = `
ALTER TABLE brain_chunk_embeddings DROP CONSTRAINT IF EXISTS brain_chunk_embeddings_pkey;
ALTER TABLE brain_chunk_embeddings ADD PRIMARY KEY (tenant_id, brain_id, chunk_id, model_fingerprint);
`;

export const BRAIN_STORE_SKILL_FEEDBACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS brain_skill_feedback (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL DEFAULT 'local',
  skill_id text NOT NULL,
  skill_version text NOT NULL,
  agent text NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('used', 'volunteered', 'rejected')),
  confidence double precision CHECK(confidence >= 0 AND confidence <= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, brain_id, id)
);
CREATE INDEX IF NOT EXISTS brain_skill_feedback_scope ON brain_skill_feedback (tenant_id, brain_id, skill_id, recorded_at DESC, id DESC);
`;

export const BRAIN_STORE_ADMIN_ACTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS brain_admin_action_receipts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  action text NOT NULL,
  target_id text NOT NULL,
  principal text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK(status IN ('running', 'complete', 'failed')),
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS brain_admin_action_receipts_scope ON brain_admin_action_receipts (tenant_id, created_at DESC);
`;

async function verifyProjectionSchema(store: BrainStore): Promise<void> {
	await store.query("SELECT 1 FROM brain_schema_meta LIMIT 1");
	for (const table of ["brain_documents", "brain_chunks", "brain_projection_runs", "brain_jobs", "brain_job_schedules", "brain_migration_history", "brain_active_projection_runs", "brain_document_revisions"]) {
		await store.query("SELECT 1 FROM " + table + " LIMIT 1");
	}
}

async function verifyBrainSchema(store: BrainStore): Promise<void> {
	await verifyProjectionSchema(store);
	for (const table of ["brain_users", "brain_tenants", "brain_identities", "brain_memberships", "brain_registry", "brain_members", "brain_model_descriptors", "brain_ingestion_runs"]) await store.query("SELECT 1 FROM " + table + " LIMIT 1");
}

async function verifyControlPlaneSchema(store: BrainStore): Promise<void> {
	await verifyBrainSchema(store);
	for (const table of ["brain_groups", "brain_group_members", "brain_visibility_grants", "brain_source_registrations", "brain_oauth_clients", "brain_web_sessions", "brain_oauth_authorization_codes", "brain_oauth_tokens", "brain_quota_usage", "brain_agent_runs", "brain_rollback_receipts", "brain_schema_upgrade_plans", "brain_migration_drills", "brain_projection_documents", "brain_projection_chunks", "brain_projection_links"]) await store.query("SELECT 1 FROM " + table + " LIMIT 1");
}

async function verifyAnalyticsSchema(store: BrainStore): Promise<void> {
	await verifyControlPlaneSchema(store);
	for (const table of ["brain_repository_snapshots", "brain_graph_nodes", "brain_graph_edges", "brain_facts", "brain_claims", "brain_timelines", "brain_source_failures", "brain_embedding_coverage", "brain_cache_entries"]) await store.query("SELECT 1 FROM " + table + " LIMIT 1");
}

async function verifyEmbeddingReplacementSchema(store: BrainStore): Promise<void> {
	await verifyAnalyticsSchema(store);
	await store.query("SELECT 1 FROM brain_chunk_embeddings LIMIT 1");
}

async function verifyEmbeddingScopeSchema(store: BrainStore): Promise<void> {
	await verifyEmbeddingReplacementSchema(store);
	await store.query("SELECT tenant_id, brain_id, chunk_id, model_fingerprint FROM brain_chunk_embeddings LIMIT 1");
}

async function verifySkillFeedbackSchema(store: BrainStore): Promise<void> {
	await verifyEmbeddingScopeSchema(store);
	await store.query("SELECT 1 FROM brain_skill_feedback LIMIT 1");
}

async function verifyAdminActionSchema(store: BrainStore): Promise<void> {
	await verifySkillFeedbackSchema(store);
	await store.query("SELECT status, result, error, completed_at FROM brain_admin_action_receipts LIMIT 1");
}

async function verifySchedulerSchema(store: BrainStore): Promise<void> {
	await verifyAdminActionSchema(store);
	await store.query("SELECT tenant_id, owner_id, lease_expires_at FROM brain_scheduler_leases LIMIT 1");
}

export const BRAIN_STORE_MIGRATIONS: DatabaseMigration[] = [
	sqlMigration(12, "initial-shared-brain-schema", BRAIN_STORE_SCHEMA, async (store) => {
		for (const table of ["brain_documents", "brain_chunks", "brain_projection_runs", "brain_jobs", "brain_job_schedules", "brain_migration_history"]) await store.query("SELECT 1 FROM " + table + " LIMIT 1");
	}),
	sqlMigration(13, "incremental-projection-runs", BRAIN_STORE_INCREMENTAL_PROJECTION_SCHEMA, verifyProjectionSchema),
	sqlMigration(14, "identity-membership-and-ingestion-state", BRAIN_STORE_IDENTITY_SCHEMA, verifyBrainSchema),
	sqlMigration(15, "durable-job-events-and-attachments", BRAIN_STORE_QUEUE_SCHEMA, async (store) => {
		await store.query("SELECT dead_lettered, progress FROM brain_jobs LIMIT 1");
		await store.query("SELECT 1 FROM brain_job_events LIMIT 1");
		await store.query("SELECT 1 FROM brain_job_attachments LIMIT 1");
	}),
	sqlMigration(16, "durable-control-plane-state", BRAIN_STORE_CONTROL_PLANE_SCHEMA, verifyControlPlaneSchema),
	sqlMigration(17, "graph-facts-cache-and-coverage", BRAIN_STORE_ANALYTICS_SCHEMA, verifyAnalyticsSchema),
	sqlMigration(18, "dependency-failure-policy", "ALTER TABLE brain_jobs ADD COLUMN IF NOT EXISTS dependency_failure_policy text NOT NULL DEFAULT 'cancel' CHECK(dependency_failure_policy IN ('cancel', 'dead-letter', 'degraded'));\n" +
		"ALTER TABLE brain_jobs ADD COLUMN IF NOT EXISTS degraded_input boolean NOT NULL DEFAULT false;\n", async (store) => {
		await store.query("SELECT dependency_failure_policy, degraded_input FROM brain_jobs LIMIT 1");
	}),
	sqlMigration(19, "access-token-user-binding", "ALTER TABLE brain_access_tokens ADD COLUMN IF NOT EXISTS user_id text;\n" +
		"CREATE INDEX IF NOT EXISTS brain_access_tokens_user_scope ON brain_access_tokens (tenant_id, user_id, revoked_at);\n", async (store) => {
		await store.query("SELECT user_id FROM brain_access_tokens LIMIT 1");
	}),
	sqlMigration(20, "model-index-replacements", BRAIN_STORE_EMBEDDING_REPLACEMENT_SCHEMA, verifyEmbeddingReplacementSchema),
	sqlMigration(21, "model-index-tenant-brain-scope", BRAIN_STORE_EMBEDDING_SCOPE_SCHEMA, verifyEmbeddingScopeSchema),
	sqlMigration(22, "durable-skill-feedback", BRAIN_STORE_SKILL_FEEDBACK_SCHEMA, verifySkillFeedbackSchema),
	sqlMigration(23, "durable-admin-action-receipts", BRAIN_STORE_ADMIN_ACTION_SCHEMA, verifyAdminActionSchema),
	sqlMigration(24, "single-owner-scheduler-leases", BRAIN_STORE_SCHEDULER_SCHEMA, verifySchedulerSchema),
];

type QueryableDatabase = Pick<PGlite, "query" | "exec"> & { close?: () => Promise<void> };

class PGliteBrainStore implements BrainStore {
	constructor(private readonly database: QueryableDatabase) {}

	async query<T extends Record<string, unknown>>(sql: string, parameters: SqlValue[] = []): Promise<T[]> {
		const result = await this.database.query<T>(sql, parameters);
		return result.rows;
	}

	async exec(sql: string): Promise<void> {
		await this.database.exec(sql);
	}

	async transaction<T>(action: (store: BrainStore) => Promise<T>): Promise<T> {
		if (!(this.database instanceof PGlite)) throw new Error("nested transactions are not supported");
		return this.database.transaction(async (transaction) => action(new PGliteBrainStore(transaction)));
	}

	async close(): Promise<void> {
		if (this.database.close) await this.database.close();
	}
}

export async function openPgliteBrainStore(dataDirectory?: string): Promise<BrainStore> {
	const options = await pgliteOptions();
	const database = dataDirectory
		? new PGlite(dataDirectory, options)
		: new PGlite(options);
	await database.waitReady;
	await database.exec("CREATE EXTENSION IF NOT EXISTS vector");
	const store = new SerializedBrainStore(new PGliteBrainStore(database));
	await runDatabaseMigrations(store, BRAIN_STORE_MIGRATIONS);
	return store;
}
