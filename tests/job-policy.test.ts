import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "brain", "job-policy"].join(String.fromCharCode(47));
const { IdempotencyLedger, assertJobBudget, classifyJobFailure, isQuietHours } = await import(modulePath);

describe("durable job policy", () => {
	test("classifies retryable failures and preserves one idempotent result", () => {
		expect(classifyJobFailure(new Error("temporary remote unavailable")).retryable).toBe(true);
		expect(classifyJobFailure(new Error("invalid payload")).retryable).toBe(false);
		const ledger = new IdempotencyLedger();
		expect(ledger.record("job-1", { commit: "a" })).toEqual({ commit: "a" });
		expect(ledger.record("job-1", { commit: "b" })).toEqual({ commit: "a" });
	});

	test("enforces privacy, authority, cost, and timezone-independent quiet hours", () => {
		expect(() => assertJobBudget({ privacy: "local", requiredAuthority: "write", maxCost: 1 }, { privacy: "hosted", authority: "read", cost: 0, durationMs: 0 })).toThrow("policy");
		expect(() => assertJobBudget({ privacy: "local", maxCost: 1 }, { privacy: "local", authority: "read", cost: 2, durationMs: 0 })).toThrow("budget");
		expect(isQuietHours(new Date("2026-07-27T03:00:00.000Z"), { startHour: 2, endHour: 4, timeZone: "UTC" })).toBe(true);
		expect(() => assertJobBudget({ privacy: "local", quietHours: { startHour: 2, endHour: 4, timeZone: "UTC" }, }, { privacy: "local", authority: "read", cost: 0, durationMs: 0, now: new Date("2026-07-27T03:00:00.000Z") })).toThrow("quiet hours");
	});
});
