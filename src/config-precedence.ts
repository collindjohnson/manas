export type ConfigurationSource = "default" | "file" | "environment" | "explicit";

export interface ConfigurationLayers<T extends Record<string, unknown>> {
	defaults: T;
	file?: Partial<T>;
	environment?: Partial<T>;
	explicit?: Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeValue(left: unknown, right: unknown): unknown {
	if (isRecord(left) && isRecord(right)) {
		const result: Record<string, unknown> = { ...left };
		for (const [key, value] of Object.entries(right)) result[key] = key in result ? mergeValue(result[key], value) : value;
		return result;
	}
	return right;
}

export function resolveConfiguration<T extends Record<string, unknown>>(layers: ConfigurationLayers<T>): T {
	return mergeValue(mergeValue(mergeValue(layers.defaults, layers.file ?? {}), layers.environment ?? {}), layers.explicit ?? {}) as T;
}

export function resolveSetting<T>(candidates: Array<{ source: ConfigurationSource; value: T | undefined }>): { source: ConfigurationSource; value: T } | undefined {
	for (const candidate of candidates.slice().reverse()) if (candidate.value !== undefined) return candidate as { source: ConfigurationSource; value: T };
	return undefined;
}

export function assertConfigurationPrecedence(): void {
	const result = resolveConfiguration({ defaults: { mode: "local", brain: { endpoint: "http://127.0.0.1" } }, file: { mode: "file" }, environment: { brain: { endpoint: "http://localhost" } }, explicit: { mode: "explicit" } });
	if (result.mode !== "explicit" || (result.brain as { endpoint: string }).endpoint !== "http://localhost") throw new Error("configuration precedence is invalid");
}
