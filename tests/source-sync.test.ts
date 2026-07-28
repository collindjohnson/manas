import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const syncModule = ["..", "src", "sources", "sync"].join(String.fromCharCode(47));
const repositoryModule = ["..", "src", "brain", "repository"].join(String.fromCharCode(47));
const { createAuditQuarantineSink, createPgliteIngestionRunLifecycle, syncSource } = await import(syncModule);
const { BrainRepository } = await import(repositoryModule);
const { openPgliteBrainStore } = await import(["..", "src", "brain", "store"].join(String.fromCharCode(47)));
const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("source synchronization", () => {
	test("updates managed content while preserving notes and marks upstream deletes stale", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-source-sync-"));
		roots.push(root);
		const brain = new BrainRepository(join(root, "brain"));
		await brain.initialize();
		await execFile("git", ["-C", brain.root, "config", "user.name", "Test"]);
		await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
		const active = { id: "fixture", describe: () => ({ id: "fixture", version: "1", kind: "test", trusted: true }), list: async () => [{ externalId: "one", suggestedPath: join("notes", "source.md"), content: "first", deleted: false, externalRevision: "v1", updatedAt: "2026-07-24T00:00:00.000Z", provenance: { sourceType: "fixture", sourcePath: "fixture-source", retrievedAt: "2026-07-24T00:00:00.000Z", metadata: { origin: "test" } }, visibilityLabels: ["team"], managedSections: ["body"] }] };
		expect(await syncSource(active, brain)).toEqual({ created: 1, updated: 0, stale: 0, quarantined: 0 });
		expect((await brain.getSettings()).sources.fixture).toEqual({ type: "fixture", version: "1", kind: "test", trusted: true });
		const first = await brain.getPage(join("notes", "source.md"));
		expect(first?.source).toEqual({ type: "fixture", externalId: "one", externalRevision: "v1", contentHash: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e", updatedAt: "2026-07-24T00:00:00.000Z", provenance: { sourceType: "fixture", sourcePath: "fixture-source", retrievedAt: "2026-07-24T00:00:00.000Z", metadata: { origin: "test" } }, visibilityLabels: ["team"], managedSections: ["body"] });
		expect(first?.accessLabels).toEqual(["team"]);
		expect(await syncSource(active, brain)).toEqual({ created: 0, updated: 0, stale: 0, quarantined: 0 });
		await brain.putPage(join("notes", "source.md"), `${first!.content}\nPersonal annotation\n`, first!.revision);
		const changed = { id: "fixture", list: async () => [{ externalId: "one", suggestedPath: join("notes", "source.md"), content: "second", deleted: false, provenance: { sourceType: "fixture", retrievedAt: "2026-07-24T00:01:00.000Z" } }] };
		expect(await syncSource(changed, brain)).toEqual({ created: 0, updated: 1, stale: 0, quarantined: 0 });
		expect((await brain.getPage(join("notes", "source.md")))?.content).toContain("Personal annotation");
		const deleted = { id: "fixture", list: async () => [{ externalId: "one", suggestedPath: join("notes", "source.md"), content: "", deleted: true, provenance: { sourceType: "fixture", retrievedAt: "2026-07-24T00:02:00.000Z" } }] };
		expect(await syncSource(deleted, brain)).toEqual({ created: 0, updated: 0, stale: 1, quarantined: 0 });
		expect((await brain.listPages())[0]?.stale).toBe(true);
	});

	test("accepts streaming source adapters", async () => {
		const pages = new Map<string, { content: string; revision: string; source?: { type: string; externalId: string } }>();
		let descriptor: unknown;
		const repository = {
			listPages: async () => [...pages.entries()].map(([path, page]) => ({ path, revision: page.revision, source: page.source })),
			getPage: async (path: string) => pages.get(path),
			putPage: async (path: string, content: string, _expected?: string, source?: { type: string; externalId: string }) => { pages.set(path, { content, revision: content, source }); },
			markStaleBySource: async () => 0,
			registerSourceDescriptor: async (value: unknown) => { descriptor = value; },
		};
		const result = await syncSource({ id: "stream", describe: () => ({ id: "stream", version: "1", kind: "fixture", trusted: true }), async *scan() { yield { externalId: "one", suggestedPath: "files/one.md", content: "streamed", deleted: false, provenance: { sourceType: "stream", retrievedAt: "2026-07-24T00:00:00.000Z" } }; } }, repository);
		expect(result).toEqual({ created: 1, updated: 0, stale: 0, quarantined: 0 });
		expect(descriptor).toEqual({ id: "stream", version: "1", kind: "fixture", trusted: true });
	});

	test("persists an adapter cursor together with the source timestamp", async () => {
		const pages = new Map<string, { content: string; revision: string; source?: { type: string; externalId: string } }>();
		let saved: { updatedAt?: string; cursor?: string } | undefined;
		const repository = {
			listPages: async () => [...pages.entries()].map(([path, page]) => ({ path, revision: page.revision, source: page.source })),
			getPage: async (path: string) => pages.get(path),
			putPage: async (path: string, content: string, _expected?: string, source?: { type: string; externalId: string }) => { pages.set(path, { content, revision: content, source }); },
			markStaleBySource: async () => 0,
		};
		const checkpoints = { get: async () => ({ cursor: "cursor-1" }), set: async (_id: string, checkpoint: { updatedAt?: string; cursor?: string }) => { saved = checkpoint; } };
		const adapter = { id: "cursor", async *scan() { yield { externalId: "one", suggestedPath: "files/one.md", content: "body", deleted: false, updatedAt: "2026-07-24T03:00:00.000Z", provenance: { sourceType: "cursor", retrievedAt: "2026-07-24T03:00:00.000Z" } }; }, checkpoint: () => ({ updatedAt: "2026-07-24T03:00:00.000Z", cursor: "cursor-2" }) };
		expect(await syncSource(adapter, repository, checkpoints)).toMatchObject({ created: 1 });
		expect(saved).toEqual({ updatedAt: "2026-07-24T03:00:00.000Z", cursor: "cursor-2" });
	});

	test("moves renamed upstream items without changing identity and marks omitted full-list items stale", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-source-rename-"));
		roots.push(root);
		const brain = new BrainRepository(join(root, "brain"));
		await brain.initialize();
		await execFile("git", ["-C", brain.root, "config", "user.name", "Test"]);
		await execFile("git", ["-C", brain.root, "config", "user.email", "test@example.invalid"]);
		let documents = [
			{ externalId: "one", suggestedPath: "files/one.md", content: "one", deleted: false, updatedAt: "2026-07-24T00:00:00.000Z", provenance: { sourceType: "fixture", retrievedAt: "2026-07-24T00:00:00.000Z" } },
			{ externalId: "two", suggestedPath: "files/two.md", content: "two", deleted: false, updatedAt: "2026-07-24T00:00:00.000Z", provenance: { sourceType: "fixture", retrievedAt: "2026-07-24T00:00:00.000Z" } },
		];
		const adapter = { id: "fixture", list: async () => documents };
		expect(await syncSource(adapter, brain)).toMatchObject({ created: 2, updated: 0, stale: 0 });
		const original = await brain.getPage("files/one.md");
		documents = [{ ...documents[0]!, suggestedPath: "files/renamed.md", updatedAt: "2026-07-24T00:01:00.000Z" }];
		expect(await syncSource(adapter, brain)).toMatchObject({ created: 0, updated: 1, stale: 1 });
		const renamed = await brain.getPage("files/renamed.md");
		expect(renamed).toMatchObject({ id: original!.id, content: expect.stringContaining("one") });
		expect(await brain.getPage("files/one.md")).toBeUndefined();
		expect((await brain.getPage("files/two.md"))?.stale).toBe(true);
		expect(await syncSource(adapter, brain)).toMatchObject({ created: 0, updated: 0, stale: 0 });
	});

	test("quarantines malformed batches without writing pages or checkpoints", async () => {
		let writes = 0;
		let checkpoints = 0;
		const events: unknown[] = [];
		const repository = { listPages: async () => [], getPage: async () => undefined, putPage: async () => { writes += 1; }, markStaleBySource: async () => 0 };
		const adapter = { id: "unsafe", list: async () => [{ externalId: "one", suggestedPath: ".." + String.fromCharCode(47) + "escape.md", content: "body", deleted: false, provenance: { sourceType: "unsafe", retrievedAt: "2026-07-24T00:00:00.000Z" } }] };
		const checkpointStore = { get: async () => undefined, set: async () => { checkpoints += 1; } };
		expect(await syncSource(adapter, repository, checkpointStore, { record: async (event: unknown) => { events.push(event); } })).toMatchObject({ created: 0, updated: 0, stale: 0, quarantined: 1 });
		expect(writes).toBe(0);
		expect(checkpoints).toBe(0);
		expect(events).toMatchObject([{ sourceId: "unsafe", documentCount: 1, reason: "source document has unsafe suggested path" }]);
	});

	test("persists quarantine metadata through the audit sink", async () => {
		const calls: unknown[][] = [];
		const store = { query: async (_sql: string, parameters?: unknown[]) => { calls.push(parameters ?? []); return [{ id: "event", tenant_id: "tenant", action: "source.quarantined", subject_id: "unsafe", metadata: parameters?.[4], created_at: "2026-07-24T00:00:00.000Z" }]; } };
		await createAuditQuarantineSink(store as never, "tenant").record({ sourceId: "unsafe", reason: "invalid", documentCount: 2, occurredAt: "2026-07-24T00:00:00.000Z" });
		expect(calls[0]?.slice(1, 4)).toEqual(["tenant", "source.quarantined", "unsafe"]);
	});

	test("persists a streaming checkpoint only after repository writes succeed", async () => {
		let saved: string | undefined;
		const repository = {
			listPages: async () => [],
			getPage: async () => undefined,
			putPage: async () => { throw new Error("write failed"); },
			markStaleBySource: async () => 0,
		};
		const adapter = { id: "checkpoint", async *scan() { yield { externalId: "one", suggestedPath: "files/one.md", content: "body", deleted: false, updatedAt: "2026-07-24T01:00:00.000Z", provenance: { sourceType: "checkpoint", retrievedAt: "2026-07-24T01:00:00.000Z" } }; } };
		const checkpoints = { get: async () => undefined, set: async (_id: string, checkpoint: { updatedAt?: string }) => { saved = checkpoint.updatedAt; } };
		await expect(syncSource(adapter, repository, checkpoints)).rejects.toThrow("write failed");
		expect(saved).toBeUndefined();
	});

	test("schedules projection before advancing the checkpoint and records lifecycle state", async () => {
		const events: string[] = [];
		const repository = {
			listPages: async () => [],
			getPage: async () => undefined,
			putPage: async () => { events.push("repository"); },
			markStaleBySource: async () => 0,
		};
		const adapter = { id: "lifecycle", async *scan() { yield { externalId: "one", suggestedPath: "files/one.md", content: "body", deleted: false, updatedAt: "2026-07-24T02:00:00.000Z", provenance: { sourceType: "lifecycle", retrievedAt: "2026-07-24T02:00:00.000Z" } }; } };
		const checkpoints = { get: async () => undefined, set: async () => { events.push("checkpoint"); } };
		const lifecycle = {
			begin: async () => { events.push("begin"); return "run-1"; },
			scheduleProjection: async () => { events.push("schedule"); },
			complete: async () => { events.push("complete"); },
			fail: async () => { events.push("fail"); },
		};
		expect(await syncSource(adapter, repository, checkpoints, undefined, lifecycle)).toMatchObject({ created: 1 });
		expect(events).toEqual(["begin", "repository", "schedule", "checkpoint", "complete"]);
	});

	test("records a scoped source failure when an ingestion run fails", async () => {
		const store = await openPgliteBrainStore();
		try {
			const lifecycle = createPgliteIngestionRunLifecycle(store, "tenant-a", "brain-a");
			const adapter = { id: "broken", async *scan() { throw new Error("upstream unavailable"); } };
			await expect(syncSource(adapter, { listPages: async () => [], getPage: async () => undefined, putPage: async () => undefined, markStaleBySource: async () => 0 }, undefined, undefined, lifecycle)).rejects.toThrow("upstream unavailable");
			expect(await store.query("SELECT tenant_id, brain_id, source_id, status, reason FROM brain_source_failures")).toMatchObject([{ tenant_id: "tenant-a", brain_id: "brain-a", source_id: "broken", status: "failed", reason: "upstream unavailable" }]);
		} finally { await store.close(); }
	});

	test("makes projection scheduling idempotent across recovery retries", async () => {
		const store = await openPgliteBrainStore();
		try {
			const lifecycle = createPgliteIngestionRunLifecycle(store, "tenant-a", "brain-a", { id: "legacy", version: "1" });
			const runId = await lifecycle.begin({ sourceId: "recoverable" });
			await lifecycle.scheduleProjection!(runId);
			await lifecycle.scheduleProjection!(runId);
			expect(await store.query("SELECT id, idempotency_key FROM brain_jobs WHERE tenant_id = $1", ["tenant-a"])).toMatchObject([{ idempotency_key: `projection:tenant-a:${runId}` }]);
			expect(await store.query("SELECT payload FROM brain_jobs WHERE tenant_id = $1", ["tenant-a"])).toMatchObject([{ payload: { brainId: "brain-a", ingestionRunId: runId, schemaPack: { id: "legacy", version: "1" } } }]);
			expect(((await store.query("SELECT count(*) AS count FROM brain_jobs WHERE tenant_id = $1", ["tenant-a"])) as Array<{ count: number }>)[0]!.count).toBe(1);
		} finally { await store.close(); }
	});
});
