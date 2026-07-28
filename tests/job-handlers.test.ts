import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { openPgliteBrainStore } from "../src/brain/store";
import { claimJob, completeJob, enqueueJob, runOneJob } from "../src/brain/jobs";
import { createParityJobHandlers, DurableJobHandlerRegistry, PARITY_JOB_TYPES } from "../src/brain/job-handlers";
import { BrainRepository } from "../src/brain/repository";
import { claimPostgresJob, POSTGRES_CLAIM_JOB_SQL } from "../src/brain/queue";

const execFile = promisify(execFileCallback);

describe("durable parity job handlers", () => {
	test("registers every required handler and makes duplicate delivery idempotent", async () => {
		const store = await openPgliteBrainStore();
		try {
			const handlers = createParityJobHandlers({ store, workerId: "worker-a", onExecute: async (type) => ({ handled: type }) });
			expect(Object.keys(handlers).sort()).toEqual([...PARITY_JOB_TYPES].sort());
			const job = await enqueueJob(store, { type: "contradiction-analysis", payload: { idempotencyKey: "same-run" } });
			const claimed = await claimJob(store, "worker-a");
			expect(claimed?.id).toBe(job.id);
			const registry = new DurableJobHandlerRegistry({ store, workerId: "worker-a", onExecute: async (type) => ({ handled: type }) });
			expect(await registry.run(claimed!)).toMatchObject({ jobId: job.id, status: "complete" });
			expect(await registry.run(claimed!)).toMatchObject({ jobId: job.id, status: "duplicate" });
			expect(await new DurableJobHandlerRegistry({ store, workerId: "replacement-worker", onExecute: async () => { throw new Error("must not execute duplicate"); } }).run(claimed!)).toMatchObject({ jobId: job.id, status: "duplicate" });
			await completeJob(store, job.id, "worker-a");
			expect((await store.query<{ count: number }>("SELECT count(*) AS count FROM brain_job_events WHERE job_id = $1", [job.id]))[0]!.count).toBe(2);
			expect((await store.query<{ progress: unknown }>("SELECT progress FROM brain_jobs WHERE id = $1", [job.id]))[0]!.progress).toMatchObject({ percent: 100 });
		} finally { await store.close(); }
	});

	test("refuses malformed parity payloads instead of accepting them silently", async () => {
		const store = await openPgliteBrainStore();
		try {
			const job = await enqueueJob(store, { type: "entity-enrichment", payload: { entities: [{}] } });
			const claimed = await claimJob(store, "worker-a");
			await expect(new DurableJobHandlerRegistry({ store, workerId: "worker-a" }).run(claimed!)).rejects.toThrow("invalid entity");
		} finally { await store.close(); }
	});

	test("synchronizes a source into the repository and schedules projection durably", async () => {
		const store = await openPgliteBrainStore();
		const directory = await mkdtemp(join(tmpdir(), "brain-job-source-"));
		const repositoryRoot = join(directory, "brain");
		try {
			const repository = new BrainRepository(repositoryRoot);
			await repository.initialize();
			await execFile("git", ["-C", repositoryRoot, "config", "user.name", "Test"]);
			await execFile("git", ["-C", repositoryRoot, "config", "user.email", "test@example.invalid"]);
			const job = await enqueueJob(store, {
				type: "source-synchronization",
				payload: {
					repositoryRoot,
					sourceId: "source-job",
					descriptor: { id: "source-job", version: "1", kind: "fixture", trusted: true },
					brainId: "local",
					documents: [{ externalId: "doc-1", suggestedPath: "notes/from-job.md", content: "source content", deleted: false, updatedAt: "2026-07-27T00:00:00.000Z", provenance: { sourceType: "source-job", retrievedAt: "2026-07-27T00:00:00.000Z" } }],
				},
			});
			const claimed = await claimJob(store, "worker-a");
			const receipt = await new DurableJobHandlerRegistry({ store, workerId: "worker-a" }).run(claimed!);
			expect(receipt).toMatchObject({ jobId: job.id, type: "source-synchronization", status: "complete" });
			await completeJob(store, job.id, "worker-a");
			expect((await repository.listPages()).map((page) => page.path)).toContain("notes/from-job.md");
			expect(await store.query("SELECT status, source_id, brain_id FROM brain_ingestion_runs WHERE tenant_id = $1", ["local"])).toMatchObject([{ status: "complete", source_id: "source-job", brain_id: "local" }]);
			expect(await store.query("SELECT type, status FROM brain_jobs WHERE tenant_id = $1 AND type = 'projection'", ["local"])).toMatchObject([{ type: "projection", status: "pending" }]);
			const projection = await claimJob(store, "worker-a");
			expect(projection?.type).toBe("projection");
			expect(await new DurableJobHandlerRegistry({ store, workerId: "worker-a" }).run(projection!)).toMatchObject({ type: "projection-repair", status: "complete" });
			await completeJob(store, projection!.id, "worker-a");
			expect(await store.query("SELECT path FROM brain_documents WHERE tenant_id = $1", ["local"])).toMatchObject([{ path: "notes/from-job.md" }]);
		} finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
	});

	test("executes bounded built-in handlers with explicit non-degraded receipts", async () => {
		const store = await openPgliteBrainStore();
		try {
			const jobs = [
				{ type: "reports", payload: {} },
				{ type: "trajectories", payload: { id: "trajectory-1", events: [{ id: "e", at: "2026-01-01T00:00:00Z", label: "start" }] } },
				{ type: "schema-synchronization", payload: { pack: { id: "default", version: "1", pathTypes: { "notes/": "note" } } } },
				{ type: "anomaly-analysis", payload: { records: [{ id: "metric", tenantId: "local", brainId: "local", baseline: 1, observed: 3 }] } },
				{ type: "dream-maintenance", payload: { brainId: "local", findings: ["repair stale links"] } },
				{ type: "skill-evaluation", payload: {} },
			] as const;
			for (const input of jobs) {
				const job = await enqueueJob(store, input);
				const claimed = await claimJob(store, "worker-a");
				const receipt = await new DurableJobHandlerRegistry({ store, workerId: "worker-a" }).run(claimed!);
				expect(receipt).toMatchObject({ jobId: job.id, type: input.type, status: "complete" });
				expect(receipt.degraded).toBeUndefined();
				await completeJob(store, job.id, "worker-a");
			}
		} finally { await store.close(); }
	});

	test("executes every bounded extraction, repair, analysis, and planning handler", async () => {
		const store = await openPgliteBrainStore();
		try {
			for (const [id, hash, stale] of [["job-doc-a", "same-hash", false], ["job-doc-b", "same-hash", false], ["job-doc-stale", "stale-hash", true], ["job-doc-orphan", "orphan-hash", false]] as const) {
				await store.query("INSERT INTO brain_documents (id, path, content_hash, revision, tenant_id, brain_id, repository_id, stale, source_updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [id, `notes/${id}.md`, hash, `revision-${id}`, "local", "local", "repo", stale, stale ? "2026-01-01T00:00:00Z" : null]);
			}
			await store.query("INSERT INTO brain_chunks (id, document_id, ordinal, text, search_vector, text_hash) VALUES ($1, $2, 0, $3, to_tsvector('english', $3), $4)", ["job-chunk-a", "job-doc-a", "source chunk", "chunk-hash"]);
			await store.query("INSERT INTO brain_links (tenant_id, brain_id, source_document_id, target_path) VALUES ($1, $2, $3, $4)", ["local", "local", "job-doc-a", "notes/missing.md"]);
			await store.query("INSERT INTO brain_facts (id, tenant_id, brain_id, subject, predicate, object_value, confidence) VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $2, $3, $4, $5, $9, $7)", ["existing-fact-a", "local", "local", "project", "status", "active", 0.9, "existing-fact-b", "paused"]);
			const inputs: Array<{ type: typeof PARITY_JOB_TYPES[number]; payload: Record<string, unknown> }> = [
				{ type: "entity-enrichment", payload: { schemaPack: { id: "default", version: "1" }, entities: [{ externalId: "person:1", label: "Person One", type: "person" }] } },
				{ type: "fact-extraction", payload: { schemaPack: { id: "default", version: "1" }, facts: [{ subject: "project", predicate: "owner", objectValue: "Person One", confidence: 0.95 }] } },
				{ type: "deduplication", payload: {} },
				{ type: "consolidation", payload: {} },
				{ type: "citation-repair", payload: { citations: [{ documentId: "job-doc-a" }, { chunkId: "missing-chunk" }] } },
				{ type: "backlink-reconciliation", payload: {} },
				{ type: "contradiction-analysis", payload: {} },
				{ type: "staleness-analysis", payload: {} },
				{ type: "orphan-analysis", payload: {} },
				{ type: "salience-analysis", payload: {} },
				{ type: "meeting-preparation", payload: { meetingId: "meeting-1", title: "Project review", participants: ["Person One"], agenda: ["Status"] } },
				{ type: "reminders", payload: { reminders: [{ id: "reminder-1", text: "Send notes", dueAt: "2026-07-28T09:00:00Z" }] } },
			];
			for (const input of inputs) {
				const job = await enqueueJob(store, input);
				const claimed = await claimJob(store, "worker-a");
				const receipt = await new DurableJobHandlerRegistry({ store, workerId: "worker-a" }).run(claimed!);
				expect(receipt).toMatchObject({ jobId: job.id, type: input.type, status: "complete" });
				await completeJob(store, job.id, "worker-a");
			}
			expect(await store.query("SELECT id FROM brain_graph_nodes WHERE external_id = $1", ["person:1"])).toHaveLength(1);
			expect(await store.query("SELECT id FROM brain_facts WHERE id = $1", ["existing-fact-a"])).toHaveLength(1);
			expect(await store.query("SELECT metadata FROM brain_facts WHERE predicate = $1", ["owner"])).toMatchObject([{ metadata: { schemaPack: { id: "default", version: "1" } } }]);
		} finally { await store.close(); }
	});

	test("routes embedding and transcription through explicit local providers", async () => {
		const store = await openPgliteBrainStore();
		const directory = await mkdtemp(join(tmpdir(), "brain-job-providers-"));
		try {
			await store.query("INSERT INTO brain_documents (id, path, content_hash, revision, tenant_id, brain_id, repository_id) VALUES ($1, $2, $3, $4, $5, $6, $7)", ["provider-doc", "notes/provider.md", "hash", "rev", "local", "local", "repo"]);
			await store.query("INSERT INTO brain_chunks (id, document_id, ordinal, text, search_vector, text_hash) VALUES ($1, $2, $3, $4, to_tsvector('english', $4), $5)", ["provider-chunk", "provider-doc", 0, "provider text", "text-hash"]);
			const embeddingProvider = { model: { id: "local-embed", dimensions: 2, fingerprint: "local-embed@1" }, embed: async (texts: string[]) => texts.map(() => [1, 0]) };
			const embeddingJob = await enqueueJob(store, { type: "embedding", payload: { brainId: "local" } });
			const embeddingClaim = await claimJob(store, "worker-a");
			const embeddingReceipt = await new DurableJobHandlerRegistry({ store, workerId: "worker-a", embeddingProvider }).run(embeddingClaim!);
			expect(embeddingReceipt).toMatchObject({ jobId: embeddingJob.id, type: "embedding", status: "complete" });
			await completeJob(store, embeddingJob.id, "worker-a");
			expect(await store.query("SELECT model_fingerprint, dimensions FROM brain_chunk_embeddings WHERE chunk_id = $1", ["provider-chunk"])).toMatchObject([{ model_fingerprint: "local-embed@1", dimensions: 2 }]);

			const audioPath = join(directory, "meeting.wav");
			await writeFile(audioPath, new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]));
			const transcriptionJob = await enqueueJob(store, { type: "transcription", payload: { path: audioPath } });
			const transcriptionClaim = await claimJob(store, "worker-a");
			const transcriptionReceipt = await new DurableJobHandlerRegistry({ store, workerId: "worker-a", transcriptionProvider: { id: "local-transcriber", transcribe: async () => "meeting notes" } }).run(transcriptionClaim!);
			expect(transcriptionReceipt).toMatchObject({ jobId: transcriptionJob.id, type: "transcription", status: "complete" });
			await completeJob(store, transcriptionJob.id, "worker-a");
			expect(JSON.stringify(await store.query("SELECT metadata FROM brain_job_events WHERE job_id = $1", [transcriptionJob.id]))).not.toContain("meeting notes");
		} finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
	});

	test("enforces handler policy metadata and skips mutations during dry runs", async () => {
		const store = await openPgliteBrainStore();
		try {
			const dryRun = await enqueueJob(store, { type: "indexing", payload: { policy: { privacy: "local", dryRun: true, actor: "codex", rollbackRef: "dry-run-ref", ownedPaths: ["notes/"], managedSections: ["managed"] } } });
			const dryRunClaim = await claimJob(store, "worker-a");
			const receipt = await new DurableJobHandlerRegistry({ store, workerId: "worker-a", authority: "admin", privacy: "local" }).run(dryRunClaim!);
			expect(receipt).toMatchObject({ jobId: dryRun.id, status: "complete" });
			await completeJob(store, dryRun.id, "worker-a");
			expect(await store.query("SELECT metadata FROM brain_job_events WHERE job_id = $1 AND event_type = 'complete'", [dryRun.id])).toMatchObject([{ metadata: { dryRun: true } }]);
			expect(await store.query("SELECT target_kind, target_id, rollback_ref FROM brain_rollback_receipts WHERE tenant_id = $1 AND target_id = $2", ["local", dryRun.id])).toMatchObject([{ target_kind: "job", target_id: dryRun.id, rollback_ref: "dry-run-ref" }]);
			expect(await store.query("SELECT action, subject_id FROM brain_audit_events WHERE tenant_id = $1 AND subject_id = $2", ["local", dryRun.id])).toMatchObject([{ action: "job.dry_run", subject_id: dryRun.id }]);

			const unsafe = await enqueueJob(store, { type: "embedding", payload: { policy: { privacy: "local", dryRun: false } } });
			const unsafeClaim = await claimJob(store, "worker-a");
			await expect(new DurableJobHandlerRegistry({ store, workerId: "worker-a" }).run(unsafeClaim!)).rejects.toThrow("actor and rollback");
			await expect(store.query("SELECT event_type FROM brain_job_events WHERE job_id = $1 AND event_type = 'failed'", [unsafe.id])).resolves.toMatchObject([{ event_type: "failed" }]);

			const overBudget = await enqueueJob(store, { type: "reports", payload: { policy: { privacy: "local", maxCost: 1, actor: "codex", rollbackRef: "cost-ref" } } });
			const overBudgetClaim = await claimJob(store, "worker-a");
			await expect(new DurableJobHandlerRegistry({ store, workerId: "worker-a", onExecute: async () => ({ cost: 2 }) }).run(overBudgetClaim!)).rejects.toThrow("budget exceeded");
		} finally { await store.close(); }
	});

	test("reuses the same durable idempotency key after a worker crash and retry", async () => {
		const store = await openPgliteBrainStore();
		const keys: string[] = [];
		let attempts = 0;
		try {
			await enqueueJob(store, { type: "reports", payload: { report: "daily" }, maxAttempts: 2 });
			const firstHandlers = createParityJobHandlers({ store, workerId: "worker-a", onExecute: async (_type, job) => { keys.push(job.idempotencyKey!); attempts += 1; if (attempts === 1) throw new Error("temporary worker crash"); return { persisted: true }; } });
			await expect(runOneJob(store, "worker-a", firstHandlers, { retryAt: new Date(0) })).rejects.toThrow("temporary worker crash");
			const secondHandlers = createParityJobHandlers({ store, workerId: "worker-b", onExecute: async (_type, job) => { keys.push(job.idempotencyKey!); return { persisted: true }; } });
			await expect(runOneJob(store, "worker-b", secondHandlers)).resolves.toMatchObject({ status: "complete" });
			expect(keys).toHaveLength(2);
			expect(keys[0]).toBe(keys[1]);
		} finally { await store.close(); }
	});

	test("uses PostgreSQL row locking and atomically leases a claim", async () => {
		const sqls: string[] = [];
		const fake = {
			transaction: async <T>(action: (store: { query<T extends Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<T[]> }) => Promise<T>) => action({ query: async <T extends Record<string, unknown>>(query: string) => { sqls.push(query); if (query.startsWith("SELECT")) return [{ id: "job", tenant_id: "tenant-a", type: "reports", payload: { ok: true }, attempts: 0, max_attempts: 3 }] as unknown as T[]; return [{ id: "job" }] as unknown as T[]; } }),
		};
		const result = await claimPostgresJob(fake, "worker-a", "tenant-a", 1_000, new Date("2026-01-01T00:00:00.000Z"));
		expect(sqls[0]).toContain("FOR UPDATE SKIP LOCKED");
		expect(result).toMatchObject({ id: "job", tenantId: "tenant-a", type: "reports", attempts: 1 });
		expect(POSTGRES_CLAIM_JOB_SQL).toContain("dead_lettered = false");
	});
});
