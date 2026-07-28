import { describe, expect, test } from "bun:test";

const storeModule = ["..", "src", "brain", "store"].join(String.fromCharCode(47));
const jobsModule = ["..", "src", "brain", "jobs"].join(String.fromCharCode(47));
const { openPgliteBrainStore } = await import(storeModule);
const { acquireSchedulerLease, attachJob, cancelJob, cancelJobTree, claimJob, completeJob, createJobSchedule, enqueueJob, failJob, listJobs, listJobSchedules, materializeDueSchedules, recordJobEvent, releaseSchedulerLease, renewJobLease, renewSchedulerLease, runOneJob, updateJobProgress } = await import(jobsModule);

describe("durable brain jobs", () => {
	test("leases jobs once, retries failures, and completes only for the owning worker", async () => {
		const store = await openPgliteBrainStore();
		try {
			const queued = await enqueueJob(store, { type: "index", payload: { commit: "abc" }, maxAttempts: 2 });
			expect(await listJobs(store)).toMatchObject([{ id: queued.id, status: "pending" }]);
			const first = await claimJob(store, "worker-a", 60_000);
			expect(first).toMatchObject({ id: queued.id, status: "running", attempts: 1, payload: { commit: "abc" } });
			expect((await renewJobLease(store, queued.id, "worker-a", 60_000)).leaseExpiresAt).toBeDefined();
			expect(await claimJob(store, "worker-b", 60_000)).toBeUndefined();
			await expect(completeJob(store, queued.id, "worker-b")).rejects.toThrow("not leased");
			expect(await failJob(store, queued.id, "worker-a", "temporary", new Date(0))).toBe("pending");
			const retried = await claimJob(store, "worker-b", 60_000);
			expect(retried).toMatchObject({ id: queued.id, attempts: 2, workerId: "worker-b" });
			await completeJob(store, queued.id, "worker-b");
			expect(await claimJob(store, "worker-c", 60_000)).toBeUndefined();
			const cancelled = await enqueueJob(store, { type: "embed", payload: {} });
			await cancelJob(store, cancelled.id);
			expect(await claimJob(store, "worker-c", 60_000)).toBeUndefined();
		} finally { await store.close(); }
	});

	test("runs a claimed handler once and records handler failures for retry", async () => {
		const store = await openPgliteBrainStore();
		try {
			await enqueueJob(store, { type: "ok", payload: {} });
			await expect(runOneJob(store, "worker", { ok: async () => undefined })).resolves.toMatchObject({ status: "complete" });
			const failed = await enqueueJob(store, { type: "bad", payload: {} });
			await expect(runOneJob(store, "worker", { bad: async () => { throw new Error("boom"); } }, { retryAt: new Date(0) })).rejects.toThrow("boom");
			const stored = await listJobs(store);
			expect(stored.find((job: { id: string }) => job.id === failed.id)).toMatchObject({ status: "pending", lastError: "boom" });
		} finally { await store.close(); }
	});

	test("persists idempotency keys across enqueue retries and tenant scopes", async () => {
		const store = await openPgliteBrainStore();
		try {
			const first = await enqueueJob(store, { type: "report", payload: { version: 1 }, tenantId: "tenant-a", idempotencyKey: "report-1" });
			const duplicate = await enqueueJob(store, { type: "report", payload: { version: 2 }, tenantId: "tenant-a", idempotencyKey: "report-1" });
			const otherTenant = await enqueueJob(store, { type: "report", payload: { version: 2 }, tenantId: "tenant-b", idempotencyKey: "report-1" });
			expect(duplicate).toMatchObject({ id: first.id, payload: { version: 1 }, idempotencyKey: "report-1" });
			expect(otherTenant.id).not.toBe(first.id);
			const rows = await store.query("SELECT count(*) AS count FROM brain_jobs WHERE idempotency_key = $1", ["report-1"]);
			expect(rows[0]!.count).toBe(2);
		} finally { await store.close(); }
	});

	test("reclaims work after an expired worker lease", async () => {
		const store = await openPgliteBrainStore();
		try {
			const now = new Date("2026-07-24T00:00:00.000Z");
			const queued = await enqueueJob(store, { type: "index", payload: {}, availableAt: now });
			expect((await claimJob(store, "crashed-worker", 1_000, now))?.id).toBe(queued.id);
			const reclaimed = await claimJob(store, "replacement-worker", 1_000, new Date(now.getTime() + 1_001));
			expect(reclaimed).toMatchObject({ id: queued.id, workerId: "replacement-worker", attempts: 2 });
		} finally { await store.close(); }
	});

	test("does not claim scheduled work before its availability time", async () => {
		const store = await openPgliteBrainStore();
		try {
			const now = new Date("2026-07-24T00:00:00.000Z");
			const queued = await enqueueJob(store, { type: "index", payload: {}, availableAt: new Date(now.getTime() + 60_000) });
			expect(await claimJob(store, "worker", 60_000, now)).toBeUndefined();
			expect(await claimJob(store, "worker", 60_000, new Date(now.getTime() + 60_000))).toMatchObject({ id: queued.id, status: "running" });
		} finally { await store.close(); }
	});

	test("waits for same-tenant dependency jobs before claiming a child", async () => {
		const store = await openPgliteBrainStore();
		try {
			const parent = await enqueueJob(store, { type: "parent", payload: {} });
			const child = await enqueueJob(store, { type: "child", payload: {}, dependencyIds: [parent.id] });
			expect(await claimJob(store, "worker", 60_000)).toMatchObject({ id: parent.id });
			await completeJob(store, parent.id, "worker");
			expect(await claimJob(store, "worker", 60_000)).toMatchObject({ id: child.id, dependencyIds: [parent.id] });
			await expect(enqueueJob(store, { type: "invalid", payload: {}, dependencyIds: ["missing"] })).rejects.toThrow("same tenant");
		} finally { await store.close(); }
	});

	test("applies an explicit dependency failure policy", async () => {
		const store = await openPgliteBrainStore();
		try {
			const cancelledParent = await enqueueJob(store, { type: "parent", payload: {}, maxAttempts: 1 });
			const cancelledChild = await enqueueJob(store, { type: "child", payload: {}, dependencyIds: [cancelledParent.id], dependencyFailurePolicy: "cancel" });
			const cancelledClaim = await claimJob(store, "worker", 60_000);
			await failJob(store, cancelledClaim!.id, "worker", "permanent");
			expect(await claimJob(store, "worker")).toBeUndefined();
			expect((await listJobs(store)).find((job: { id: string }) => job.id === cancelledChild.id)).toMatchObject({ status: "cancelled", dependencyFailurePolicy: "cancel" });

			const deadParent = await enqueueJob(store, { type: "parent", payload: {}, maxAttempts: 1 });
			const deadChild = await enqueueJob(store, { type: "child", payload: {}, dependencyIds: [deadParent.id], dependencyFailurePolicy: "dead-letter" });
			const deadClaim = await claimJob(store, "worker", 60_000);
			await failJob(store, deadClaim!.id, "worker", "permanent");
			expect(await claimJob(store, "worker")).toBeUndefined();
			expect((await listJobs(store)).find((job: { id: string }) => job.id === deadChild.id)).toMatchObject({ status: "failed", deadLettered: true, dependencyFailurePolicy: "dead-letter" });

			const degradedParent = await enqueueJob(store, { type: "parent", payload: {}, maxAttempts: 1 });
			const degradedChild = await enqueueJob(store, { type: "child", payload: {}, dependencyIds: [degradedParent.id], dependencyFailurePolicy: "degraded" });
			const degradedClaim = await claimJob(store, "worker", 60_000);
			await failJob(store, degradedClaim!.id, "worker", "permanent");
			expect(await claimJob(store, "worker")).toMatchObject({ id: degradedChild.id, degradedInput: true, dependencyFailurePolicy: "degraded" });
		} finally { await store.close(); }
	});

	test("scopes listings and worker claims to a tenant", async () => {
		const store = await openPgliteBrainStore();
		try {
			const tenantA = await enqueueJob(store, { type: "index", payload: {}, tenantId: "tenant-a" });
			await enqueueJob(store, { type: "index", payload: {}, tenantId: "tenant-b" });
			expect(await listJobs(store, 100)).toEqual([]);
			expect(await listJobs(store, 100, "tenant-a")).toMatchObject([{ id: tenantA.id, tenantId: "tenant-a" }]);
			expect(await claimJob(store, "worker", 60_000, new Date(), "tenant-b")).toMatchObject({ tenantId: "tenant-b" });
			expect(await claimJob(store, "worker", 60_000, new Date(), "tenant-a")).toMatchObject({ id: tenantA.id, tenantId: "tenant-a" });
		} finally { await store.close(); }
	});

	test("materializes one due job per recurring schedule and advances its clock", async () => {
		const store = await openPgliteBrainStore();
		try {
			const now = new Date("2026-07-24T00:00:00.000Z");
			const schedule = await createJobSchedule(store, { type: "index", payload: { repositoryRoot: "brain" }, intervalSeconds: 60, nextRunAt: now });
			expect(await materializeDueSchedules(store, "local", now)).toMatchObject([{ type: "index", payload: { repositoryRoot: "brain" } }]);
			expect(await materializeDueSchedules(store, "local", now)).toEqual([]);
			expect(await listJobSchedules(store)).toMatchObject([{ id: schedule.id, nextRunAt: "2026-07-24T00:01:00.000Z" }]);
		} finally { await store.close(); }
	});

	test("enforces one scheduler owner per tenant and recovers expired leases", async () => {
		const store = await openPgliteBrainStore();
		try {
			const now = new Date("2026-07-24T00:00:00.000Z");
			expect(await acquireSchedulerLease(store, "scheduler-a", 1_000, "tenant-a", now)).toBe(true);
			expect(await acquireSchedulerLease(store, "scheduler-b", 1_000, "tenant-a", new Date(now.getTime() + 500))).toBe(false);
			expect(await renewSchedulerLease(store, "scheduler-b", 1_000, "tenant-a", now)).toBe(false);
			expect(await renewSchedulerLease(store, "scheduler-a", 1_000, "tenant-a", now)).toBe(true);
			expect(await acquireSchedulerLease(store, "scheduler-b", 1_000, "tenant-a", new Date(now.getTime() + 1_001))).toBe(true);
			expect(await releaseSchedulerLease(store, "scheduler-a", "tenant-a")).toBe(false);
			expect(await releaseSchedulerLease(store, "scheduler-b", "tenant-a")).toBe(true);
		} finally { await store.close(); }
	});

	test("records progress, events, attachments, dead-letter state, and dependent cancellation", async () => {
		const store = await openPgliteBrainStore();
		try {
			const parent = await enqueueJob(store, { type: "parent", payload: {}, maxAttempts: 1 });
			const child = await enqueueJob(store, { type: "child", payload: {}, dependencyIds: [parent.id] });
			const running = await claimJob(store, "worker", 60_000);
			expect(running?.id).toBe(parent.id);
			await updateJobProgress(store, parent.id, "worker", { completed: 1, total: 2 });
			expect((await listJobs(store)).find((job: { id: string }) => job.id === parent.id)?.progress).toEqual({ completed: 1, total: 2 });
			expect((await recordJobEvent(store, { jobId: parent.id, eventType: "progress", metadata: { completed: 1 } })).eventType).toBe("progress");
			expect((await attachJob(store, { jobId: parent.id, name: "input.json", bytes: 12 })).byteCount).toBe(12);
			expect(await failJob(store, parent.id, "worker", "permanent", new Date(0))).toBe("failed");
			expect((await listJobs(store)).find((job: { id: string }) => job.id === parent.id)).toMatchObject({ status: "failed", deadLettered: true });
			expect(await cancelJobTree(store, parent.id)).toBe(1);
			expect((await listJobs(store)).find((job: { id: string }) => job.id === child.id)).toMatchObject({ status: "cancelled" });
		} finally { await store.close(); }
	});
});
