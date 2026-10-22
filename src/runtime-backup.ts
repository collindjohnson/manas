import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "./config";
import { defaultConfig } from "./config";
import { acquireStoreOwnership } from "./brain/ownership";
import { BrainRepository } from "./brain/repository";
import { openPgliteBrainStore } from "./brain/store";
import { indexBrainRepositoryIsolated } from "./brain/pglite-indexer";

export interface RuntimeBackupEntry { path: string; bytes: number; sha256: string; directory?: true }
export interface RuntimeBackupManifest {
  version: 1; id: string; createdAt: string; brainId: string; repositoryId: string; commit: string;
  sourceRepository: string; sourceStore: string; credentialsIncluded: false; entries: RuntimeBackupEntry[];
}
export class RuntimeBackupError extends Error {
  readonly retryable = false;
  constructor(readonly code: string, message: string, readonly suggestedFix: string) { super(message); }
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function inside(parent: string, child: string) { const rel = relative(parent, child); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); }
function excluded(path: string) { return path === ".brain/mutation.lock" || path === ".manas-owner.sqlite" || path.startsWith(".manas-owner.sqlite-"); }
function withinBudget(deadline: number) { if (Date.now() >= deadline) throw new RuntimeBackupError("backup_budget_exceeded", "Backup exceeded its consistency time budget.", "Use a faster local backup destination and retry into a new directory."); }
async function inventory(root: string, prefix: string, current = root, deadline = Infinity): Promise<RuntimeBackupEntry[]> {
  const result: RuntimeBackupEntry[] = [];
  for (const name of (await readdir(current)).sort()) {
    withinBudget(deadline);
    const path = join(current, name), rel = relative(root, path);
    if (excluded(rel)) continue;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new RuntimeBackupError("backup_unsafe_file", "Backup refuses symbolic links.", "Use a standalone brain checkout and regular operational store.");
    if (stat.isDirectory()) { result.push({ path: prefix + "/" + rel, bytes: 0, sha256: hash(new Uint8Array()), directory: true }); result.push(...await inventory(root, prefix, path, deadline)); }
    else if (stat.isFile() && stat.size <= 256 * 1024 * 1024) {
      const bytes = await readFile(path);
      result.push({ path: prefix + "/" + rel, bytes: bytes.length, sha256: hash(bytes) });
    } else throw new RuntimeBackupError("backup_unsafe_file", "Backup refuses special files or files larger than 256 MiB.", "Inspect the source and use a supported offline backup for oversized files.");
    if (result.length > 100_000) throw new Error("backup exceeds the 100000 file budget");
  }
  return result;
}
async function rootDirectory(path: string) {
  if (!isAbsolute(path)) throw new Error("backup paths must be absolute");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("backup source must be a regular directory");
  return realpath(path);
}
async function standaloneGit(root: string) {
  const gitPath = join(root, ".git");
  const stat = await lstat(gitPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("backup requires a standalone Git checkout");
  const forbiddenEnvironment = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];
  if (forbiddenEnvironment.some((name) => process.env[name] !== undefined)) throw new Error("backup requires Git environment overrides to be unset");
  const child = Bun.spawn(["git", "-C", root, "config", "--get", "core.worktree"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode === 0) throw new Error("backup refuses an explicit core.worktree path; use an ordinary self-contained checkout");
  if (exitCode !== 1) throw new Error("unable to inspect Git worktree configuration");
  for (const name of ["commondir", "objects/info/alternates", "objects/info/http-alternates"]) {
    try { await lstat(join(gitPath, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw new Error("backup requires self-contained Git objects without external alternates");
  }
}
async function destinationPath(path: string) {
  if (!isAbsolute(path)) throw new Error("backup paths must be absolute");
  // Resolve existing parents to prevent a symlink alias from placing the destination in a source.
  return join(await realpath(join(path, "..")), relative(join(path, ".."), resolve(path)));
}
async function syncPath(path: string) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectories(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await syncDirectories(join(path, entry.name));
  await syncPath(path);
}
async function writeDurable(path: string, value: unknown) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncPath(join(path, ".."));
}
async function copyEntries(source: string, destination: string, entries: RuntimeBackupEntry[], stripPrefix = false, deadline = Infinity) {
  for (const entry of entries) {
    withinBudget(deadline);
    const sourcePath = stripPrefix ? entry.path.slice(entry.path.indexOf("/") + 1) : entry.path;
    const target = join(destination, entry.path);
    if (entry.directory) { await mkdir(target, { recursive: true, mode: 0o700 }); continue; }
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    await copyFile(join(source, sourcePath), target);
    const bytes = await readFile(target);
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error("backup copy failed hash verification");
    await syncPath(target);
  }
}
export async function createRuntimeBackup(config: Config, input: { repositoryRoot: string; storePath: string; destination: string }): Promise<RuntimeBackupManifest> {
  const repositoryRoot = await rootDirectory(input.repositoryRoot), storePath = await rootDirectory(input.storePath), destination = await destinationPath(input.destination);
  if (inside(repositoryRoot, storePath) || inside(storePath, repositoryRoot) || inside(repositoryRoot, destination) || inside(storePath, destination)) throw new Error("backup roots must be disjoint and destination outside the sources");
  await standaloneGit(repositoryRoot);
  const stateRoot = await destinationPath(config.stateRoot);
  if (inside(repositoryRoot, stateRoot)) throw new Error("operational state must be outside the Git brain repository");
  const releaseRuntime = await acquireStoreOwnership(join(config.stateRoot, "service"));
  let releaseStore: (() => void) | undefined;
  try {
    releaseStore = await acquireStoreOwnership(storePath);
    // Existing destinations are never reused, overwritten, or automatically removed.
    await mkdir(destination, { mode: 0o700 });
    const repository = new BrainRepository(repositoryRoot);
    const manifest = await repository.withConsistentSnapshot(async (snapshot) => {
      const deadline = Date.now() + 230_000;
      const [brain, operational] = await Promise.all([inventory(repositoryRoot, "brain", repositoryRoot, deadline), inventory(storePath, "operational", storePath, deadline)]);
      await copyEntries(repositoryRoot, destination, brain, true, deadline);
      await copyEntries(storePath, destination, operational, true, deadline);
      const [afterBrain, afterOperational] = await Promise.all([inventory(repositoryRoot, "brain", repositoryRoot, deadline), inventory(storePath, "operational", storePath, deadline)]);
      if (JSON.stringify(brain) !== JSON.stringify(afterBrain) || JSON.stringify(operational) !== JSON.stringify(afterOperational)) throw new Error("source changed while copying backup");
      return { version: 1 as const, id: randomUUID(), createdAt: new Date().toISOString(), brainId: snapshot.brainId, repositoryId: snapshot.repositoryId, commit: snapshot.commit, sourceRepository: repositoryRoot, sourceStore: storePath, credentialsIncluded: false as const, entries: [...brain, ...operational] };
    });
    await syncDirectories(destination); await syncPath(join(destination, ".."));
    await writeDurable(join(destination, "manifest.json"), manifest);
    return manifest;
  } finally { releaseStore?.(); releaseRuntime(); }
}
export async function verifyRuntimeBackup(path: string): Promise<RuntimeBackupManifest> {
  const root = await rootDirectory(path);
  const stat = await lstat(join(root, "manifest.json"));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error("backup manifest must be a bounded regular file");
  const value = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as RuntimeBackupManifest;
  if (typeof value.sourceRepository !== "string" || !isAbsolute(value.sourceRepository) || typeof value.sourceStore !== "string" || !isAbsolute(value.sourceStore) || value.version !== 1 || value.credentialsIncluded !== false || !value.id || !value.brainId || !value.repositoryId || !/^[a-f0-9]{40}$/.test(value.commit) || !Array.isArray(value.entries) || value.entries.length > 100_000) throw new Error("invalid backup manifest");
  const paths = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== "string" || !/^(brain|operational)\//.test(entry.path) || entry.path.includes("\\") || entry.path.split("/").some((part) => !part || part === "." || part === "..") || paths.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 256 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("invalid backup inventory");
    if (entry.directory !== undefined && entry.directory !== true || entry.directory && (entry.bytes !== 0 || entry.sha256 !== hash(new Uint8Array()))) throw new Error("invalid backup directory");
    paths.add(entry.path);
  }
  await rootDirectory(join(root, "brain")); await rootDirectory(join(root, "operational"));
  const entries = [...await inventory(join(root, "brain"), "brain"), ...await inventory(join(root, "operational"), "operational")];
  if (JSON.stringify(entries) !== JSON.stringify(value.entries)) throw new Error("backup integrity verification failed");
  await standaloneGit(join(root, "brain"));
  const repository = new BrainRepository(join(root, "brain"));
  const snapshot = await repository.snapshot();
  if (snapshot.commit !== value.commit || snapshot.brainId !== value.brainId || snapshot.repositoryId !== value.repositoryId || !(await repository.verify()).valid) throw new Error("backup canonical identity verification failed");
  return value;
}
export async function restoreRuntimeBackup(input: { backupPath: string; destination: string }) {
  const manifest = await verifyRuntimeBackup(input.backupPath);
  const destination = await destinationPath(input.destination);
  const source = await rootDirectory(input.backupPath);
  if ([source, manifest.sourceRepository, manifest.sourceStore].some((root) => inside(root, destination))) throw new Error("restore destination must be outside the backup and original sources");
  await mkdir(destination, { mode: 0o700 });
  await copyEntries(source, destination, manifest.entries);
  const repositoryRoot = join(destination, "brain"), storePath = join(destination, "operational"), stateRoot = join(destination, "state");
  const repository = new BrainRepository(repositoryRoot);
  const store = await openPgliteBrainStore(storePath);
  try {
    // Preserve operational history, but require fresh authority on a restored installation.
    await store.transaction(async (transaction) => {
      await transaction.query("UPDATE brain_access_tokens SET revoked_at = COALESCE(revoked_at, now())");
      await transaction.query("UPDATE brain_oauth_tokens SET revoked_at = COALESCE(revoked_at, now())");
      await transaction.query("UPDATE brain_web_sessions SET revoked_at = COALESCE(revoked_at, now())");
      await transaction.query("UPDATE brain_owner_sessions SET revoked_at = COALESCE(revoked_at, now())");
      await transaction.query("UPDATE brain_oauth_clients SET revoked_at = COALESCE(revoked_at, now())");
      await transaction.query("UPDATE brain_oauth_authorization_codes SET redeemed_at = COALESCE(redeemed_at, now())");
      await transaction.query("UPDATE brain_jobs SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL, last_error = 'Restored installation: review and reauthorize before retrying', updated_at = now() WHERE status IN ('pending', 'running')");
      await transaction.query("UPDATE brain_job_schedules SET enabled = false");
      await transaction.query("UPDATE brain_catalog_executions SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL, last_error = 'restore_reauthorization_required', retryable = false, updated_at = now() WHERE status IN ('pending', 'running')");
      await transaction.query("UPDATE brain_admin_action_receipts SET status='complete',result=jsonb_set(jsonb_set(result,'{phase}','\"suppressed\"'::jsonb),'{reason}','\"restore_reauthorization_required\"'::jsonb),completed_at=now() WHERE action='open-loop-reminder' AND result->>'phase' IN ('queued','dispatching')");
      await transaction.query("UPDATE brain_google_sources SET enabled = false, revision = revision || ':restored', worker_id = NULL, lease_expires_at = NULL");
      await transaction.query("DELETE FROM brain_scheduler_leases");
      await transaction.query("DELETE FROM brain_active_projection_runs");
      await transaction.query("DELETE FROM brain_cache_entries");
      await transaction.query("DELETE FROM brain_projection_runs WHERE brain_id = $1 AND git_commit = $2", [manifest.brainId, manifest.commit]);
    });
    await indexBrainRepositoryIsolated(store, repository);
  } finally { await store.close(); }
  await mkdir(stateRoot, { mode: 0o700 });
  const configPath = join(destination, "config.json");
  const config = defaultConfig({ MANAS_ARCHIVE: join(destination, "legacy-archive"), MANAS_STATE: stateRoot });
  await writeDurable(configPath, config);
  await writeDurable(join(stateRoot, "canonical-runtime.json"), { version: 1, mode: "canonical", migrationId: "restore:" + manifest.id, repositoryRoot, storePath, baseCommit: manifest.commit, selectedAt: new Date().toISOString() });
  const receipt = { version: 1, backupId: manifest.id, restoredAt: new Date().toISOString(), brainId: manifest.brainId, repositoryId: manifest.repositoryId, commit: manifest.commit, repositoryRoot, storePath, stateRoot, configPath, credentialsReconnectionRequired: true, clientsReinstallationRequired: true, jobsRequireReview: true };
  await syncDirectories(destination); await syncPath(join(destination, ".."));
  await writeDurable(join(destination, "restore-receipt.json"), receipt);
  return receipt;
}

export const RUNTIME_BACKUP_CATALOG = [
  { name: "backup.create", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["repositoryRoot", "storePath", "destination"], properties: { repositoryRoot: { type: "string" }, storePath: { type: "string" }, destination: { type: "string" } }, additionalProperties: false } },
  { name: "backup.verify", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["backupPath"], properties: { backupPath: { type: "string" } }, additionalProperties: false } },
  { name: "backup.restore", scope: "admin", boundary: "local-only", schema: { type: "object", required: ["backupPath", "destination"], properties: { backupPath: { type: "string" }, destination: { type: "string" } }, additionalProperties: false } },
] as const;
export function runtimeBackupOperations(config: Config): import("./brain/operation-registry").OperationDefinition[] {
  return RUNTIME_BACKUP_CATALOG.map((entry) => ({
    name: entry.name, description: entry.name === "backup.create" ? "Create a consistent offline Git and operational-state backup. Stop the service first." : entry.name === "backup.verify" ? "Verify backup inventory hashes and canonical Git identity." : "Restore into a new installation, rebuild projections, and pause restored access and work for owner review.",
    requiredScope: entry.scope, trustBoundary: entry.boundary, inputSchema: entry.schema, outputSchema: { type: "object" },
    execute: async (context, input) => {
      if (context.scope !== "admin" || (context.tenantId ?? "local") !== "local" || context.allowedAccessLabels !== undefined) throw new Error("backup requires unrestricted owner administration");
      if (context.signal?.aborted) throw new Error("backup cancelled");
      if (entry.name === "backup.create") return createRuntimeBackup(config, input as { repositoryRoot: string; storePath: string; destination: string });
      if (entry.name === "backup.verify") return verifyRuntimeBackup((input as { backupPath: string }).backupPath);
      return restoreRuntimeBackup(input as { backupPath: string; destination: string });
    },
  }));
}
