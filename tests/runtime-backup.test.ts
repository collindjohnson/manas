import { createOwnerSession, authorizeOwnerSession } from "../src/brain/owner-sessions";
import { startExecution } from "../src/brain/catalog-execution";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { BrainRepository } from "../src/brain/repository";
import { openPgliteBrainStore } from "../src/brain/store";
import { indexBrainRepository, searchVerifiedHybridBrainRepository } from "../src/brain/pglite-indexer";
import { remember, forget, recall } from "../src/brain/memory";
import { enqueueJob } from "../src/brain/jobs";
import { createPersonalAccessToken, authorizePersonalAccessToken } from "../src/brain/access-tokens";
import { createRuntimeBackup, verifyRuntimeBackup, restoreRuntimeBackup, runtimeBackupOperations } from "../src/runtime-backup";
import { createFullOperationRegistry } from "../src/brain/operation-catalog";
import { OperationRegistry } from "../src/brain/operation-registry";
import { acquireStoreOwnership } from "../src/brain/ownership";
const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const owner = { scope: "admin" as const, principal: "owner", tenantId: "local" };
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), "manas-runtime-backup-")); roots.push(root);
 const repository = new BrainRepository(join(root, "brain")); await repository.initialize();
 await execFile("git", ["-C", repository.root, "config", "user.name", "Test"]);
 await execFile("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
 const page = await repository.putPage("notes/orbit.md", "Orbital telescope calibration belongs to Alice.");
 const config = { archiveRoot: join(root, "archive"), stateRoot: join(root, "state"), launchAgentPath: join(root, "agents", "legacy.plist") };
 const storePath = join(root, "runtime"), store = await openPgliteBrainStore(storePath);
 await indexBrainRepository(store, repository); await store.close();
 return { root, repository, repositoryRoot: repository.root, config, storePath, page, destination: join(root, "backup") };
}
test("runtime backup restores canonical history, operational receipts, withdrawals and a rebuilt projection", async () => {
 const f = await fixture(), store = await openPgliteBrainStore(f.storePath);
 const memory = await remember(f.repository, owner, { text: "Withdrawn lantern secret", idempotencyKey: "memory", provenance: { sourceType: "user" } });
 await forget(f.repository, owner, { id: memory.id, expectedRevision: memory.revision, idempotencyKey: "forget" });
 const job = await enqueueJob(store, { type: "index", payload: { repositoryRoot: f.repository.root }, idempotencyKey: "pending" });
 const execution = await startExecution({ store, repository: f.repository }, owner, { idempotencyKey: "restore-execution", steps: [{ operation: "entities.resolve", input: { query: "Alice" } }] });
 const token = await createPersonalAccessToken(store, { name: "old device", scopes: ["read"] });
 await store.query("INSERT INTO brain_operational_state (key,value) VALUES ('feedback-receipt',$1::jsonb)", [JSON.stringify({ rating: 1, evidenceRevision: f.page.revision })]);
 const brainId = (await f.repository.getIdentity()).brainId;
 const browser = await createOwnerSession(store, brainId, "http://127.0.0.1:1234");
 await store.query("INSERT INTO brain_google_sources (id,tenant_id,brain_id,boundary,revision,cursor) VALUES ('source','local',$1,'{}','revision',$2::jsonb)", [brainId, JSON.stringify({ historyId: "123" })]);
 await store.close();
 await writeFile(join(f.repository.root, "notes", "uncommitted.md"), "preserve my user edit");
 const manifest = await createRuntimeBackup(f.config, f);
 expect((await verifyRuntimeBackup(f.destination)).id).toBe(manifest.id);
 expect(manifest.entries.some((entry) => entry.path.includes("mutation.lock") || entry.path.includes(".manas-owner.sqlite"))).toBe(false);
 const result = await restoreRuntimeBackup({ backupPath: f.destination, destination: join(f.root, "restored") });
 expect(result.brainId).toBe(brainId);
 const restoredConfig = JSON.parse(await readFile(result.configPath, "utf8"));
 expect(restoredConfig.brain.databasePath.startsWith(result.stateRoot + "/")).toBe(true);
 expect(await readFile(join(result.repositoryRoot, "notes", "uncommitted.md"), "utf8")).toBe("preserve my user edit");
 const restoredRepository = new BrainRepository(result.repositoryRoot), restoredStore = await openPgliteBrainStore(result.storePath);
 try {
  expect((await recall(restoredRepository, owner, { query: "lantern" })).results).toEqual([]);
  expect(await searchVerifiedHybridBrainRepository(restoredStore, restoredRepository, "lantern", { brainId })).toEqual([]);
  expect((await searchVerifiedHybridBrainRepository(restoredStore, restoredRepository, "telescope", { brainId }))[0]?.citation.documentId).toBe(f.page.id);
  expect((await restoredStore.query("SELECT value FROM brain_operational_state WHERE key='feedback-receipt'"))[0]?.value).toEqual({ rating: 1, evidenceRevision: f.page.revision });
  expect((await restoredStore.query("SELECT cursor,enabled FROM brain_google_sources WHERE id='source'"))[0]).toEqual({ cursor: { historyId: "123" }, enabled: false });
  expect((await restoredStore.query("SELECT status FROM brain_jobs WHERE id=$1", [job.id]))[0]?.status).toBe("cancelled");
  expect(await authorizePersonalAccessToken(restoredStore, token.token, "read")).toBe(false);
  await expect(authorizeOwnerSession(restoredStore, brainId, "http://127.0.0.1:1234", browser.id, browser.csrf)).rejects.toThrow();
  expect((await restoredStore.query("SELECT status,last_error FROM brain_catalog_executions WHERE id=$1", [execution.id]))[0]).toMatchObject({ status: "cancelled", last_error: "restore_reauthorization_required" });
 } finally { await restoredStore.close(); }
 const cli = Bun.spawn([process.execPath, "src/cli.ts", "search", "telescope", "--config", result.configPath], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, MANAS_CONFIG: undefined } });
 const [output, error, code] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
 if (code !== 0) throw new Error(output + error);
 expect(code).toBe(0); expect(error).toBe(""); expect(output).toContain(f.page.id);
 expect((await verifyRuntimeBackup(f.destination)).id).toBe(manifest.id);
}, 30_000);
test("runtime backup refuses live owners, existing destinations, and source aliases", async () => {
 const f = await fixture();
 const release = await acquireStoreOwnership(f.storePath);
 try { await expect(createRuntimeBackup(f.config, f)).rejects.toMatchObject({ code: "store_owned" }); } finally { release(); }
 await mkdir(f.destination);
 await expect(createRuntimeBackup(f.config, f)).rejects.toThrow();
 await expect(createRuntimeBackup(f.config, { ...f, destination: join(f.repository.root, "unsafe") })).rejects.toThrow("outside");
 const alias = join(f.root, "alias"); await symlink(f.repository.root, alias);
 await expect(createRuntimeBackup(f.config, { ...f, destination: join(alias, "unsafe") })).rejects.toThrow("outside");
});
test("runtime backup verifies corruption and unsafe manifests before creating a restore", async () => {
 const f = await fixture(); await createRuntimeBackup(f.config, f);
 await writeFile(join(f.destination, "brain", "notes", "orbit.md"), "corrupted");
 await expect(restoreRuntimeBackup({ backupPath: f.destination, destination: join(f.root, "restore") })).rejects.toThrow("integrity");
 await expect(readFile(join(f.root, "restore", "config.json"))).rejects.toThrow();
 const manifestPath = join(f.destination, "manifest.json");
 const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.entries[0].path = "brain/../../escape";
 await writeFile(manifestPath, JSON.stringify(manifest));
 await expect(verifyRuntimeBackup(f.destination)).rejects.toThrow("inventory");
});

test("backup catalog shares owner-only schemas and CLI verification", async () => {
 const f = await fixture();
 const registry = createFullOperationRegistry({ repository: f.repository, backupConfig: f.config });
 for (const operation of runtimeBackupOperations(f.config)) {
  expect(registry.get(operation.name).inputSchema).toEqual(operation.inputSchema);
  await expect(registry.execute({ scope: "write" }, operation.name, {})).rejects.toThrow("scope");
 }
 const local = new OperationRegistry(); for (const operation of runtimeBackupOperations(f.config)) local.register(operation);
 await expect(local.execute({ ...owner, allowedAccessLabels: [] }, "backup.create", { repositoryRoot: f.repositoryRoot, storePath: f.storePath, destination: f.destination })).rejects.toThrow("owner");
 const serviceRelease = await acquireStoreOwnership(join(f.config.stateRoot, "service"));
 try { await expect(createRuntimeBackup(f.config, f)).rejects.toMatchObject({ code: "store_owned" }); } finally { serviceRelease(); }
 const manifest = await registry.execute(owner, "backup.create", { repositoryRoot: f.repositoryRoot, storePath: f.storePath, destination: f.destination }) as { id: string };
 const cli = Bun.spawn([process.execPath, "src/cli.ts", "backup", "verify", "--from", f.destination, "--json"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, MANAS_CONFIG: undefined } });
 const [stdout, stderr, exitCode] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
 expect(exitCode).toBe(0); expect(stderr).toBe("");
 expect(JSON.parse(stdout).data.id).toBe(manifest.id);
 await expect(restoreRuntimeBackup({ backupPath: f.destination, destination: f.destination })).rejects.toThrow("outside");
});

test("runtime backups reject Git redirections and state nested inside the brain", async () => {
 const f = await fixture();
 await execFile("git", ["-C", f.repositoryRoot, "config", "core.worktree", f.repositoryRoot]);
 await expect(createRuntimeBackup(f.config, f)).rejects.toThrow("core.worktree");
 await execFile("git", ["-C", f.repositoryRoot, "config", "--unset", "core.worktree"]);
 await expect(createRuntimeBackup({ ...f.config, stateRoot: join(f.repositoryRoot, "state") }, f)).rejects.toThrow("outside");
 await mkdir(join(f.repositoryRoot, ".git", "objects", "info"), { recursive: true });
 await writeFile(join(f.repositoryRoot, ".git", "objects", "info", "alternates"), "/outside/objects");
 await expect(createRuntimeBackup(f.config, f)).rejects.toThrow("alternates");
});
