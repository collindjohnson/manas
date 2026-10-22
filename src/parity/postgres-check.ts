import { createOwnerSession, authorizeOwnerSession } from "../brain/owner-sessions";
import { extractMaintenanceAnalysis, completeMaintenanceAnalysis } from "../brain/maintenance-extraction";
import { startExecution, executionStatus, catalogExecutionHandler } from "../brain/catalog-execution";
import { createFullOperationRegistry } from "../brain/operation-catalog";
import { materializeDueSchedules } from "../brain/jobs";
import { setGoogleSourceEnabled, scheduleGoogleSource } from "../brain/google-jobs";
import { googleBoundaryHash } from "../sources/google-pages";
import { GoogleReadClient } from "../sources/google-api";
import { syncGooglePage } from "../brain/google-sync";
import { definePin, createAnswer, getAnswer, answerFeedback } from "../brain/maintained-answers";
import { createHash } from "node:crypto";
import { manageAgentHooks } from "../agent-hooks";
import { stageCaptureTurn, enqueueCaptureTurn, memoryCaptureHandler } from "../brain/memory-capture";
import { recall } from "../brain/memory";
import { runOneJob, completeJob, cancelJob } from "../brain/jobs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { openPostgresBrainStore } from "../brain/postgres-store";
import { BRAIN_STORE_MIGRATIONS } from "../brain/store";
import { postgresRlsStatements, enablePostgresRls, setPostgresTenantContext } from "../brain/rls";
import { BrainRepository } from "../brain/repository";
import { indexBrainRepositoryIncremental, searchVerifiedBrainRepository, searchVerifiedHybridBrainRepository } from "../brain/pglite-indexer";
import { indexLocalEmbeddings } from "../brain/local-embeddings";
import { enqueueJob } from "../brain/jobs";
import { claimPostgresJob } from "../brain/queue";
import { runProjectionContract, runProjectionMutationContract } from "./projection-contract";

const execFile = promisify(execFileCallback);

const connectionString = process.env.MANAS_POSTGRES_URL;
if (!connectionString) {
	if (process.argv.includes("--require")) {
		console.error("PostgreSQL contract required: set MANAS_POSTGRES_URL to a disposable pgvector database");
		process.exit(1);
	}
	console.log("PostgreSQL contract skipped: set MANAS_POSTGRES_URL to a disposable pgvector database");
	process.exit(0);
}

const store = await openPostgresBrainStore(connectionString);
const root = await mkdtemp(join(tmpdir(), "manas-postgres-contract-"));
const rlsRole = "brain_rls_contract";
let createdRlsRole = false;
try {
	const history = await store.query<{ version: number }>("SELECT version FROM brain_migration_history ORDER BY version");
	const latestVersion = BRAIN_STORE_MIGRATIONS[BRAIN_STORE_MIGRATIONS.length - 1]!.version;
	if (history.at(-1)?.version !== latestVersion) throw new Error(`PostgreSQL migration contract did not reach schema version ${latestVersion}`);
	if (postgresRlsStatements().length < 2) throw new Error("PostgreSQL RLS contract is empty");
	const repository = new BrainRepository(join(root, "brain"));
	await repository.initialize();
	await execFile("git", ["-C", repository.root, "config", "user.name", "PostgreSQL Contract"]);
	await execFile("git", ["-C", repository.root, "config", "user.email", "postgres-contract@example.invalid"]);
	await repository.putPage("notes/parity.md", "Parity projection citation contract.");
	const projection = await runProjectionContract(store, repository);
	if (projection.revisionCount < 1 || projection.results[0]?.verifiedText !== projection.results[0]?.text) throw new Error("PostgreSQL projection citation contract failed");
	const previousSnapshot = await repository.snapshot(projection.commit);
	const previousPage = previousSnapshot.pages.find((page) => page.path === "notes/parity.md");
	if (!previousPage) throw new Error("PostgreSQL incremental projection fixture is missing");
	await repository.putPage("notes/parity.md", "Parity projection citation contract updated.", previousPage.revision);
	const incremental = await indexBrainRepositoryIncremental(store, repository, { fromCommit: projection.commit });
	if (incremental.commit === projection.commit || !incremental.delta?.updated.length) throw new Error("PostgreSQL incremental projection contract failed");
	const incrementalResults = await searchVerifiedBrainRepository(store, repository, "updated", 5, undefined, undefined, "local");
	if (!incrementalResults.length || incrementalResults[0]?.verifiedText !== "Parity projection citation contract updated." || incrementalResults[0]?.citation.commit !== incremental.commit) throw new Error("PostgreSQL incremental citation contract failed");
	const mutation = await runProjectionMutationContract(store, repository, incremental.commit);
	if (!mutation.stableChunkIds.length || mutation.verifiedText !== "projection target") throw new Error("PostgreSQL projection mutation matrix failed");
	const snapshot = await repository.snapshot();
	const embeddingProvider = { model: { id: "postgres-contract-local", dimensions: 2 }, embed: async (texts: string[]) => texts.map((text) => text.toLowerCase().includes("parity") ? [1, 0] : [0, 1]) };
	await indexLocalEmbeddings(store, embeddingProvider, 8, { tenantId: "local", brainId: snapshot.brainId });
	const hybrid = await searchVerifiedHybridBrainRepository(store, repository, "parity", { embeddingProvider, tenantId: "local", brainId: snapshot.brainId, limit: 5 });
	if (!hybrid.length || hybrid[0]?.verifiedText !== hybrid[0]?.text || hybrid[0]?.citation.commit !== snapshot.commit) throw new Error("PostgreSQL hybrid retrieval contract failed");
	const captureState = join(root, "capture-state"), captureHome = join(root, "capture-home");
	const installationId = createHash("sha256").update("codex:" + captureHome).digest("hex");
	await manageAgentHooks({ agent: "codex", home: captureHome, stateRoot: captureState, configPath: join(root, "capture-config.json"), executable: [process.execPath, "src/cli.ts"], capture: true }, "install");
	const captureInput = { installationId, sessionId: "postgres-session", turnId: "postgres-turn", prompt: "Juniper maintainer is Maya." };
	await stageCaptureTurn(store, captureState, captureInput, snapshot.brainId);
	const captureJob = await enqueueCaptureTurn(store, captureState, captureInput, snapshot.brainId);
	const captureResult = await runOneJob(store, "capture-worker", { "memory-capture": memoryCaptureHandler({ store, repository, stateRoot: captureState, workerId: "capture-worker", provider: { generate: async () => JSON.stringify({ spans: [{ start: 0, end: captureInput.prompt.length }] }) } }) });
	if (captureResult?.id !== captureJob.jobId || captureResult.status !== "complete") throw new Error("PostgreSQL capture queue contract failed");
	const captured = await recall(repository, { scope: "read", tenantId: "local", allowedAccessLabels: ["personal"] }, { query: "Juniper" });
	if (captured.results.length !== 1 || captured.results[0]?.text !== captureInput.prompt) throw new Error("PostgreSQL memory capture contract failed");
 const answerContext = { scope: "write" as const, principal: "postgres-answer", allowedAccessLabels: ["personal"] };
 const answerDependencies = { store, repository, provider: { generate: async (prompt: string) => {
  const input = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
  return JSON.stringify({ answer: "Maya", citations: [input.evidence[0].chunkId], knowledgeGaps: [] });
 } } };
 const answer = await createAnswer(answerDependencies, answerContext, "Juniper maintainer");
 if (answer.outcome !== "answered" || (await getAnswer(answerDependencies, answerContext, answer.answerId)).freshness !== "current") throw new Error("PostgreSQL answer receipt contract failed");
 const rating = { answerId: answer.answerId, rating: 1, idempotencyKey: "postgres-rating" };
 const feedback = await answerFeedback(answerDependencies, answerContext, rating);
 if (feedback.rankingInfluence !== false || (await answerFeedback(answerDependencies, answerContext, { ...rating, idempotencyKey: "duplicate-rating" })).id !== feedback.id) throw new Error("PostgreSQL feedback deduplication contract failed");
 const pin = await definePin(answerDependencies, answerContext, { question: "Juniper maintainer", visibility: ["personal"], idempotencyKey: "postgres-pin" });
 if (!pin.revision || (await definePin(answerDependencies, answerContext, { question: "Juniper maintainer", visibility: ["personal"], idempotencyKey: "postgres-pin" })).id !== pin.id) throw new Error("PostgreSQL pinned question contract failed");

	const queued = await enqueueJob(store, { tenantId: "local", type: "postgres-contract", payload: { commit: snapshot.commit }, idempotencyKey: "postgres-contract-job" });
	const claimed = await claimPostgresJob(store, "postgres-contract-worker", "local", 60_000, new Date());
	if (!claimed || claimed.id !== queued.id || claimed.type !== "postgres-contract") throw new Error("PostgreSQL SKIP LOCKED queue contract failed");

 const googleBoundary = { accountId: "a".repeat(64), accountEmail: "contract@example.invalid", visibility: ["personal"], service: "contacts" as const, groupIds: [], allContacts: true };
 const googleClient = new GoogleReadClient(async () => "fixture-token", async () => Response.json({ connections: [{ resourceName: "people/contract", metadata: {}, names: [{ displayName: "Contract Contact" }] }], nextSyncToken: "checkpoint" }));
 let interrupted = true;
 await syncGooglePage({ store, repository, client: googleClient, boundary: googleBoundary, workerId: "contract-google", faultInjector: async (point) => { if (point === "after-git-write" && interrupted) { interrupted = false; throw new Error("contract interruption"); } } }).catch((error) => { if (error.message !== "contract interruption") throw error; });
 const googleReceipt = await syncGooglePage({ store, repository, client: googleClient, boundary: googleBoundary, workerId: "contract-google" });
 if (!googleReceipt.complete || googleReceipt.cursor.syncToken !== "checkpoint") throw new Error("PostgreSQL Google checkpoint replay failed");
 const googleChange = { id: googleReceipt.sourceId, expectedRevision: googleBoundaryHash(googleBoundary), enabled: false, idempotencyKey: "postgres-google-disable" };
 const googleStopped = await setGoogleSourceEnabled({ store, repository }, { scope: "admin", principal: "postgres-owner" }, googleChange);
 const googleRestarted = await setGoogleSourceEnabled({ store, repository }, { scope: "admin", principal: "postgres-owner" }, { ...googleChange, expectedRevision: googleStopped.revision, enabled: true, idempotencyKey: "postgres-google-enable" });
 const googleReplay = await setGoogleSourceEnabled({ store, repository }, { scope: "admin", principal: "postgres-owner" }, googleChange);
 if (!googleReplay.replayed || googleStopped.revision === googleRestarted.revision || googleStopped.enabled || !googleRestarted.enabled) throw new Error("PostgreSQL Google revocation epoch contract failed");
 const googleOwner = { scope: "admin" as const, principal: "postgres-owner" };
 const googleSchedule = { id: googleReceipt.sourceId, expectedRevision: googleRestarted.revision, intervalSeconds: 60, enabled: true, idempotencyKey: "postgres-google-schedule", runImmediately: true };
 await scheduleGoogleSource({ store, repository }, googleOwner, googleSchedule);
 const scheduledRuns = (await Promise.all([materializeDueSchedules(store), materializeDueSchedules(store)])).flat().filter((job) => job.type === "google-source-sync");
 if (scheduledRuns.length !== 1) throw new Error("PostgreSQL concurrent Google schedules duplicated work");
 await store.query("UPDATE brain_jobs SET status='complete',worker_id=NULL,lease_expires_at=NULL WHERE id=$1", [scheduledRuns[0]!.id]);
 await scheduleGoogleSource({ store, repository }, googleOwner, { ...googleSchedule, idempotencyKey: "postgres-google-reschedule" });
 await Promise.all([
  materializeDueSchedules(store),
  setGoogleSourceEnabled({ store, repository }, googleOwner, { id: googleReceipt.sourceId, expectedRevision: googleRestarted.revision, enabled: false, idempotencyKey: "postgres-google-concurrent-disable" }),
 ]);
 const survivingGoogleJobs = await store.query("SELECT id FROM brain_jobs WHERE tenant_id='local' AND type='google-source-sync' AND payload->>'sourceId'=$1 AND status IN ('pending','running')", [googleReceipt.sourceId]);
 if (survivingGoogleJobs.length) throw new Error("PostgreSQL Google disable raced schedule materialization");



 const executionDependencies = { store, repository };
 const executionContext = { scope: "admin" as const, principal: "postgres-executor", tenantId: "local" };
 const executionPlan = { idempotencyKey: "postgres-execution", steps: [{ operation: "retrieval.search", input: { query: "Parity" }, maximumOutputTokens: 65536 }] };
 const concurrentExecutions = await Promise.all([startExecution(executionDependencies, executionContext, executionPlan), startExecution(executionDependencies, executionContext, executionPlan)]);
 if (concurrentExecutions[0]!.id !== concurrentExecutions[1]!.id || concurrentExecutions.filter((run) => run.replayed).length !== 1) throw new Error("PostgreSQL execution idempotency contract failed");
 const execution = concurrentExecutions[0]!;
 const executionRegistry = createFullOperationRegistry({ repository, store });
 const executionJobs = await store.query<Record<string, unknown>>("UPDATE brain_jobs SET status='running',worker_id='execution-worker',lease_expires_at=now()+interval '60 seconds',attempts=attempts+1 WHERE id=$1 RETURNING id,tenant_id,type,payload,status,attempts,max_attempts", [execution.jobId]);
 const rawExecutionJob = executionJobs[0]! as unknown as { id: string; tenant_id: string; type: string; payload: unknown; status: "running"; attempts: number; max_attempts: number };
 await catalogExecutionHandler({ ...executionDependencies, workerId: "execution-worker", execute: (context, operation, input) => executionRegistry.execute(context, operation, input) })({ id: rawExecutionJob.id, tenantId: rawExecutionJob.tenant_id, type: rawExecutionJob.type, payload: rawExecutionJob.payload, status: "running", priority: 0, attempts: rawExecutionJob.attempts, maxAttempts: rawExecutionJob.max_attempts, dependencyIds: [], dependencyFailurePolicy: "cancel", availableAt: new Date().toISOString() });
 await completeJob(store, execution.jobId, "execution-worker");
 const executionReceipt = await executionStatus(executionDependencies, executionContext, { id: execution.id });
 if (executionReceipt.status !== "complete" || executionReceipt.steps[0]?.status !== "complete" || executionReceipt.usage.items !== 1) throw new Error("PostgreSQL execution step receipt contract failed");


 const cancellation = await startExecution(executionDependencies, executionContext, { ...executionPlan, idempotencyKey: "postgres-cancel" });
 await store.query("UPDATE brain_jobs SET status='running',worker_id='cancel-executor',lease_expires_at=now()+interval '60 seconds',attempts=1 WHERE id=$1", [cancellation.jobId]);
 let beginCancellation!: () => void;
 const cancellationStarted = new Promise<void>((resolve) => { beginCancellation = resolve; });
 const cancellationWork = catalogExecutionHandler({ ...executionDependencies, workerId: "cancel-executor", execute: async (context) => { beginCancellation(); await new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => resolve(), { once: true })); return { late: true }; } })({ id: cancellation.jobId, tenantId: "local", type: "catalog-execution", payload: { executionId: cancellation.id, brainId: snapshot.brainId }, status: "running", priority: 0, attempts: 1, maxAttempts: 3, dependencyIds: [], dependencyFailurePolicy: "cancel", availableAt: new Date().toISOString() }).catch((error) => error);
 await cancellationStarted;
 await cancelJob(store, cancellation.jobId);
 await cancellationWork;
 const cancelledExecution = await executionStatus(executionDependencies, executionContext, { id: cancellation.id, includeHistoricalResults: true });
 if (cancelledExecution.status !== "cancelled" || cancelledExecution.steps[0]?.result !== null) throw new Error("PostgreSQL concurrent execution cancellation published a late result");


 const maintenancePage = await repository.putPage("notes/maintenance-contract.md", "A durable local assertion.");
 const maintenanceSnapshot = await repository.snapshot();
 const maintenanceProvider = { id: "postgres-local-fixture", generate: async () => JSON.stringify({ spans: [{ start: 0, end: 26 }] }) };
 const maintenanceAnalysis = await extractMaintenanceAnalysis({ store, repository, snapshot: maintenanceSnapshot, page: maintenancePage, provider: maintenanceProvider, check: async () => {} });
 if (maintenanceAnalysis.evidence.length !== 1 || maintenanceAnalysis.evidence[0]?.documentId !== maintenancePage.id || !maintenanceAnalysis.done || !maintenanceAnalysis.analyzer) throw new Error("PostgreSQL maintenance analysis did not freeze source evidence");
 await completeMaintenanceAnalysis(store, maintenanceSnapshot, maintenancePage, maintenanceProvider, maintenanceAnalysis.analyzer);
 const analysis = await store.query<{ completed: boolean }>("SELECT completed FROM brain_maintenance_analysis");
 if (analysis.length !== 1 || !analysis[0]?.completed) throw new Error("PostgreSQL maintenance checkpoint did not complete");

 const ownerSession = await createOwnerSession(store, snapshot.brainId, "http://127.0.0.1:1234");
 await authorizeOwnerSession(store, snapshot.brainId, "http://127.0.0.1:1234", ownerSession.id, ownerSession.csrf);
	await enablePostgresRls(store);
	const existingRoles = await store.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = $1", [rlsRole]);
	if (!existingRoles.length) {
		await store.exec(`CREATE ROLE ${rlsRole} NOLOGIN`);
		createdRlsRole = true;
	}
	await store.exec(`GRANT USAGE ON SCHEMA public TO ${rlsRole}`);
	await store.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${rlsRole}`);
	await store.exec(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${rlsRole}`);
	await store.transaction(async (transaction) => {
		await transaction.exec(`SET LOCAL ROLE ${rlsRole}`);
		await setPostgresTenantContext(transaction, "local");
		const visible = await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM brain_documents");
		if ((visible[0]?.count ?? 0) < 1) throw new Error("PostgreSQL RLS hid the active tenant projection");
		const turns = await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM brain_capture_turns");
		if ((turns[0]?.count ?? 0) !== 1) throw new Error("PostgreSQL RLS hid the active tenant capture turn");
  for (const table of ["brain_owner_sessions", "brain_maintenance_analysis", "brain_answer_receipts", "brain_answer_feedback", "brain_google_sources", "brain_google_batches", "brain_google_seen", "brain_google_attempts", "brain_catalog_executions", "brain_catalog_execution_steps"]) {
   const rows = await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM " + table);
   if (rows[0]?.count !== (table.startsWith("brain_catalog_") ? 2 : 1)) throw new Error("PostgreSQL RLS hid active answer state");
  }
	});
	await store.transaction(async (transaction) => {
		await transaction.exec(`SET LOCAL ROLE ${rlsRole}`);
		await setPostgresTenantContext(transaction, "other-tenant");
		const hidden = await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM brain_documents");
		if ((hidden[0]?.count ?? 0) !== 0) throw new Error("PostgreSQL RLS leaked a projection across tenants");
		const turns = await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM brain_capture_turns");
		if ((turns[0]?.count ?? 0) !== 0) throw new Error("PostgreSQL RLS leaked a capture turn across tenants");
  for (const table of ["brain_owner_sessions", "brain_maintenance_analysis", "brain_answer_receipts", "brain_answer_feedback", "brain_google_sources", "brain_google_batches", "brain_google_seen", "brain_google_attempts", "brain_catalog_executions", "brain_catalog_execution_steps"]) {
   const rows = await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM " + table);
   if (rows[0]?.count !== 0) throw new Error("PostgreSQL RLS leaked answer state across tenants");
  }
	});
	await store.transaction(async (transaction) => {
		await transaction.exec(`SET LOCAL ROLE ${rlsRole}`);
		await setPostgresTenantContext(transaction, "parity-tenant");
		await transaction.query("INSERT INTO brain_tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", ["parity-tenant", "Parity"]);
		await transaction.query("INSERT INTO brain_users (id) VALUES ($1) ON CONFLICT DO NOTHING", ["parity-user"]);
		await transaction.query("INSERT INTO brain_memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", ["parity-user", "parity-tenant"]);
		const rows = await transaction.query<{ id: string }>("SELECT id FROM brain_tenants WHERE id = $1", ["parity-tenant"]);
		if (!rows.length) throw new Error("PostgreSQL tenant transaction did not commit");
	});
	await store.query("INSERT INTO brain_tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", ["local", "Local"]);
	await store.query("INSERT INTO brain_users (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING", ["authorized-user", "unauthorized-user"]);
	await store.query("INSERT INTO brain_registry (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [snapshot.brainId, "local", "Contract brain"]);
	await store.query("INSERT INTO brain_memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", ["authorized-user", "local"]);
	await store.transaction(async (transaction) => {
		await transaction.exec(`SET LOCAL ROLE ${rlsRole}`);
		await setPostgresTenantContext(transaction, "local", "unauthorized-user");
		const hidden = await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM brain_documents");
		if ((hidden[0]?.count ?? 0) !== 0) throw new Error("PostgreSQL RLS leaked a brain to an unauthorized user");
		const turns = await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM brain_capture_turns");
		if ((turns[0]?.count ?? 0) !== 0) throw new Error("PostgreSQL RLS leaked a capture turn to an unauthorized user");
  for (const table of ["brain_owner_sessions", "brain_maintenance_analysis", "brain_catalog_executions", "brain_catalog_execution_steps"]) {
   const hidden = await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM " + table);
   if (hidden[0]?.count !== 0) throw new Error("PostgreSQL RLS leaked execution history to an unauthorized user");
  }
	});
	await store.transaction(async (transaction) => {
		await transaction.exec(`SET LOCAL ROLE ${rlsRole}`);
		await setPostgresTenantContext(transaction, "local", "authorized-user");
		const visible = await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM brain_documents");
		if ((visible[0]?.count ?? 0) < 1) throw new Error("PostgreSQL RLS hid a brain from an authorized user");
	});
	console.log("PostgreSQL contract passed");
} finally {
	if (createdRlsRole) await store.exec(`DROP ROLE IF EXISTS ${rlsRole}`).catch(() => undefined);
	await store.close();
	await rm(root, { recursive: true, force: true });
}
