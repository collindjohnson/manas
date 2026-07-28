import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "queue"].join(String.fromCharCode(47));
const { POSTGRES_CLAIM_JOB_SQL, assertPgliteSchedulerOwner, computeBackoff } = await import(modulePath);

describe("queue mechanics", () => {
	test("uses PostgreSQL row locks and bounded jittered backoff", () => {
		expect(POSTGRES_CLAIM_JOB_SQL).toContain("FOR UPDATE SKIP LOCKED");
		expect(computeBackoff(1, 100, 10_000, 0)).toBe(50);
		expect(computeBackoff(20, 100, 200, 1)).toBe(200);
	});

	test("allows the owner or an expired lease and rejects competing PGLite workers", () => {
		const current = { owner: "one", acquiredAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:01:00.000Z" };
		expect(() => assertPgliteSchedulerOwner(current, "one", new Date("2026-01-01T00:00:30.000Z"))).not.toThrow();
		expect(() => assertPgliteSchedulerOwner(current, "two", new Date("2026-01-01T00:00:30.000Z"))).toThrow("owned");
		expect(() => assertPgliteSchedulerOwner(current, "two", new Date("2026-01-01T00:02:00.000Z"))).not.toThrow();
	});
});
