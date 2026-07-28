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
	const queued = await enqueueJob(store, { tenantId: "local", type: "postgres-contract", payload: { commit: snapshot.commit }, idempotencyKey: "postgres-contract-job" });
	const claimed = await claimPostgresJob(store, "postgres-contract-worker", "local", 60_000, new Date());
	if (!claimed || claimed.id !== queued.id || claimed.type !== "postgres-contract") throw new Error("PostgreSQL SKIP LOCKED queue contract failed");
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
	});
	await store.transaction(async (transaction) => {
		await transaction.exec(`SET LOCAL ROLE ${rlsRole}`);
		await setPostgresTenantContext(transaction, "other-tenant");
		const hidden = await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM brain_documents");
		if ((hidden[0]?.count ?? 0) !== 0) throw new Error("PostgreSQL RLS leaked a projection across tenants");
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
