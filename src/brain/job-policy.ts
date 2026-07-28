export type JobPrivacy = "local" | "hosted";
export interface JobBudget {
	maxCost?: number;
	maxDurationMs?: number;
	requiredAuthority?: "read" | "write" | "admin";
	privacy: JobPrivacy;
	quietHours?: { startHour: number; endHour: number; timeZone?: string };
}
export interface RetryDecision { retryable: boolean; reason: string; retryAt?: Date; }

const authorityRank = { read: 1, write: 2, admin: 3 };

export function classifyJobFailure(error: unknown, now = new Date()): RetryDecision {
	const reason = error instanceof Error ? error.message : "job failed";
	const normalized = reason.toLowerCase();
	if (normalized.includes("invalid") || normalized.includes("unauthorized") || normalized.includes("forbidden") || normalized.includes("scope") || normalized.includes("quota")) return { retryable: false, reason };
	if (normalized.includes("timeout") || normalized.includes("temporar") || normalized.includes("unavailable") || normalized.includes("connection") || normalized.includes("remote")) return { retryable: true, reason, retryAt: new Date(now.getTime() + 30_000) };
	return { retryable: false, reason };
}

export function assertJobBudget(budget: JobBudget, observed: { cost: number; durationMs: number; authority: "read" | "write" | "admin"; privacy: JobPrivacy; now?: Date }): void {
	if (!["local", "hosted"].includes(budget.privacy) || !Number.isFinite(observed.cost) || observed.cost < 0 || !Number.isFinite(observed.durationMs) || observed.durationMs < 0 || authorityRank[observed.authority] < authorityRank[budget.requiredAuthority ?? "read"] || budget.privacy === "local" && observed.privacy !== "local") throw new Error("job budget or authority policy rejected execution");
	if (budget.maxCost !== undefined && observed.cost > budget.maxCost || budget.maxDurationMs !== undefined && observed.durationMs > budget.maxDurationMs) throw new Error("job budget exceeded");
	if (budget.quietHours && isQuietHours(observed.now ?? new Date(), budget.quietHours)) throw new Error("job is deferred during quiet hours");
}

export function isQuietHours(now: Date, window: { startHour: number; endHour: number; timeZone?: string }): boolean {
	if (!Number.isInteger(window.startHour) || window.startHour < 0 || window.startHour > 23 || !Number.isInteger(window.endHour) || window.endHour < 0 || window.endHour > 23) throw new Error("invalid quiet-hours window");
	const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "2-digit", hourCycle: "h23", timeZone: window.timeZone ?? "UTC" }).format(now));
	return window.startHour < window.endHour ? hour >= window.startHour && hour < window.endHour : hour >= window.startHour || hour < window.endHour;
}

export class IdempotencyLedger {
	private readonly results = new Map<string, unknown>();
	get<T>(key: string): T | undefined { return this.results.get(key) as T | undefined; }
	record<T>(key: string, result: T): T {
		if (!key.trim()) throw new Error("job idempotency key is required");
		if (this.results.has(key)) return this.results.get(key) as T;
		this.results.set(key, result);
		return result;
	}
}
