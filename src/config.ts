import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveConfiguration } from "./config-precedence";

type Environment = Readonly<Record<string, string | undefined>>;

export type ProviderPrivacy = "local" | "hosted";

/** Serializable provider configuration. Secrets may be supplied by an env layer. */
export interface ProviderEndpointConfig {
	endpoint: string;
	model: string;
	privacy: ProviderPrivacy;
	apiKey?: string;
	provider?: string;
	revision?: string;
	dimensions?: number;
}

export interface ProviderConfig {
	embedding?: ProviderEndpointConfig;
	reranking?: ProviderEndpointConfig;
	generation?: ProviderEndpointConfig;
	transcription?: ProviderEndpointConfig;
	extraction?: ProviderEndpointConfig;
}

export type ConfigOAuthScope = "read" | "write" | "admin";

export interface OAuthClientConfig {
	id: string;
	redirectUris: string[];
	allowedScopes: ConfigOAuthScope[];
	confidential: boolean;
	clientSecret?: string;
	tenantId?: string;
}

export interface AuthConfig {
	oauth?: {
		allowedOrigin?: string;
		clients?: OAuthClientConfig[];
	};
	session?: {
		idleMs?: number;
		absoluteMs?: number;
		secure?: boolean;
	};
}

export interface BrainConfig {
	databasePath: string;
	zeroEntropyBaseUrl: string;
	zeroEntropyCollection: string;
	zeroEntropyBatchSize: number;
	chunkTargetChars: number;
	chunkMaxChars: number;
	retrievalLimit: number;
	synthesisEvidenceLimit: number;
	requestTimeoutMs: number;
	// Optional for programmatic callers created before these limits existed;
	// defaultConfig always supplies bounded values.
	retryAttempts?: number;
	retryBackoffMs?: number;
	remoteOversample?: number;
	remotePollIntervalMs?: number;
	remotePollDurationMs?: number;
	snippetChars?: number;
	questionMaxChars?: number;
	synthesisEvidenceChars?: number;
	diagnostics?: boolean;
	codexTimeoutMs: number;
	synthesisCommand: string;
	rerankerEndpoint?: string;
	rerankerModel?: string;
	generationEndpoint?: string;
	generationModel?: string;
	keychainService: string;
	keychainAccount: string;
}

export interface Config {
	archiveRoot: string;
	stateRoot: string;
	launchAgentPath: string;
	brain?: BrainConfig;
	providers?: ProviderConfig;
	auth?: AuthConfig;
}

function boundedInteger(
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
	environment: Environment,
): number {
	const value = environment[name];
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
		throw new Error(
			`${name} must be an integer between ${minimum} and ${maximum}`,
		);
	return parsed;
}

function optionalBoundedInteger(
	name: string,
	minimum: number,
	maximum: number,
	environment: Environment,
): number | undefined {
	if (environment[name] === undefined) return undefined;
	return boundedInteger(name, minimum, minimum, maximum, environment);
}

function providerFromEnvironment(
	prefix: string,
	environment: Environment,
	options: { dimensions?: boolean } = {},
): Partial<ProviderEndpointConfig> | undefined {
	const endpoint = environment[`${prefix}_ENDPOINT`];
	const model = environment[`${prefix}_MODEL`];
	const apiKey = environment[`${prefix}_API_KEY`];
	const provider = environment[`${prefix}_PROVIDER`];
	const revision = environment[`${prefix}_REVISION`];
	const privacy = environment[`${prefix}_PRIVACY`] as ProviderPrivacy | undefined;
	const dimensions = options.dimensions
		? optionalBoundedInteger(`${prefix}_DIMENSIONS`, 1, 65_536, environment)
		: undefined;
	if (endpoint === undefined && model === undefined && apiKey === undefined && provider === undefined && revision === undefined && privacy === undefined && dimensions === undefined) return undefined;
	return {
		...(endpoint === undefined ? {} : { endpoint }),
		...(model === undefined ? {} : { model }),
		...(privacy === undefined ? {} : { privacy }),
		...(apiKey === undefined ? {} : { apiKey }),
		...(provider === undefined ? {} : { provider }),
		...(revision === undefined ? {} : { revision }),
		...(dimensions === undefined ? {} : { dimensions }),
	};
}

export function defaultConfig(environment: Environment = process.env): Config {
	const home = homedir();
	const chunkTargetChars = boundedInteger(
		"MANAS_CHUNK_TARGET",
		3_000,
		100,
		100_000,
		environment,
	);
	const chunkMaxChars = boundedInteger(
		"MANAS_CHUNK_MAX",
		6_000,
		100,
		200_000,
		environment,
	);
	if (chunkTargetChars > chunkMaxChars)
		throw new Error(
			"MANAS_CHUNK_TARGET must not exceed MANAS_CHUNK_MAX",
		);
	const stateRoot = resolve(
		environment.MANAS_STATE ??
			`${home}/.local/state/manas`,
	);
	const providers: Record<string, Partial<ProviderEndpointConfig> | undefined> = {
		embedding: providerFromEnvironment("MANAS_PROVIDER_EMBEDDING", environment, { dimensions: true }),
		reranking: providerFromEnvironment("MANAS_PROVIDER_RERANKING", environment),
		generation: providerFromEnvironment("MANAS_PROVIDER_GENERATION", environment),
		transcription: providerFromEnvironment("MANAS_PROVIDER_TRANSCRIPTION", environment),
		extraction: providerFromEnvironment("MANAS_PROVIDER_EXTRACTION", environment),
	};
	const configuredProviders = Object.fromEntries(Object.entries(providers).filter(([, value]) => value !== undefined)) as ProviderConfig;
	const sessionIdleMs = optionalBoundedInteger("MANAS_SESSION_IDLE_MS", 1_000, 7 * 24 * 60 * 60_000, environment);
	const sessionAbsoluteMs = optionalBoundedInteger("MANAS_SESSION_ABSOLUTE_MS", 1_000, 30 * 24 * 60 * 60_000, environment);
	const auth: AuthConfig = {
		...(environment.MANAS_OAUTH_ALLOWED_ORIGIN === undefined ? {} : { oauth: { allowedOrigin: environment.MANAS_OAUTH_ALLOWED_ORIGIN } }),
		...(sessionIdleMs === undefined && sessionAbsoluteMs === undefined ? {} : { session: { ...(sessionIdleMs === undefined ? {} : { idleMs: sessionIdleMs }), ...(sessionAbsoluteMs === undefined ? {} : { absoluteMs: sessionAbsoluteMs }) } }),
	};
	return {
		archiveRoot: resolve(
			environment.MANAS_ARCHIVE ??
				`${home}/.local/share/manas/archive`,
		),
		stateRoot,
		launchAgentPath: resolve(
			environment.MANAS_LAUNCH_AGENT ??
				`${home}/Library/LaunchAgents/com.collindjohnson.manas.plist`,
		),
		brain: {
			databasePath: resolve(
				environment.MANAS_DATABASE ?? `${stateRoot}/brain.sqlite`,
			),
			zeroEntropyBaseUrl:
				environment.MANAS_ZEROENTROPY_URL ??
				"https://api.zeroentropy.dev/v1",
			zeroEntropyCollection:
				 environment.MANAS_ZEROENTROPY_COLLECTION ??
				"manas",
			zeroEntropyBatchSize: boundedInteger(
				"MANAS_ZEROENTROPY_BATCH_SIZE",
				32,
				1,
				128,
				environment,
			),
			chunkTargetChars,
			chunkMaxChars,
			retrievalLimit: boundedInteger(
				"MANAS_RETRIEVAL_LIMIT",
				20,
				1,
				100,
				environment,
			),
			synthesisEvidenceLimit: boundedInteger(
				"MANAS_SYNTHESIS_EVIDENCE_LIMIT",
				8,
				1,
				50,
				environment,
			),
			requestTimeoutMs: boundedInteger(
				"MANAS_REQUEST_TIMEOUT_MS",
				30_000,
				100,
				300_000,
				environment,
			),
			retryAttempts: boundedInteger(
				"MANAS_RETRY_ATTEMPTS",
				3,
				1,
				10,
				environment,
			),
			retryBackoffMs: boundedInteger(
				"MANAS_RETRY_BACKOFF_MS",
				250,
				1,
				10_000,
				environment,
			),
			remoteOversample: boundedInteger(
				"MANAS_REMOTE_OVERSAMPLE",
				4,
				1,
				10,
				environment,
			),
			remotePollIntervalMs: boundedInteger(
				"MANAS_REMOTE_POLL_INTERVAL_MS",
				1_000,
				100,
				60_000,
				environment,
			),
			remotePollDurationMs: boundedInteger(
				"MANAS_REMOTE_POLL_DURATION_MS",
				30_000,
				100,
				600_000,
				environment,
			),
			snippetChars: boundedInteger(
				"MANAS_SNIPPET_CHARS",
				500,
				50,
				10_000,
				environment,
			),
			questionMaxChars: boundedInteger(
				"MANAS_QUESTION_MAX_CHARS",
				2_000,
				1,
				20_000,
				environment,
			),
			synthesisEvidenceChars: boundedInteger(
				"MANAS_SYNTHESIS_EVIDENCE_CHARS",
				12_000,
				100,
				200_000,
				environment,
			),
				diagnostics: environment.MANAS_DIAGNOSTICS === "1",
			codexTimeoutMs: boundedInteger(
				"MANAS_CODEX_TIMEOUT_MS",
				60_000,
				100,
				600_000,
				environment,
			),
			synthesisCommand:
				environment.MANAS_SYNTHESIS_COMMAND ?? "codex",
			rerankerEndpoint: environment.MANAS_RERANKER_ENDPOINT,
			rerankerModel: environment.MANAS_RERANKER_MODEL,
			generationEndpoint: environment.MANAS_GENERATION_ENDPOINT,
			generationModel: environment.MANAS_GENERATION_MODEL,
			keychainService:
				environment.MANAS_ZEROENTROPY_KEYCHAIN_SERVICE ??
				"manas.zeroentropy",
			keychainAccount:
				environment.MANAS_ZEROENTROPY_KEYCHAIN_ACCOUNT ?? "api-key",
		},
		...(Object.keys(configuredProviders).length ? { providers: configuredProviders } : {}),
		...(Object.keys(auth).length ? { auth } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value: unknown, allowed: readonly string[], field: string): void {
	if (!isRecord(value)) return;
	const accepted = new Set(allowed);
	const unknown = Object.keys(value).filter((key) => !accepted.has(key));
	if (unknown.length) throw new Error(`${field} contains unknown setting: ${unknown[0]}`);
}

function assertConfigShape(value: unknown, field = "configuration"): void {
	if (value === undefined) return;
	if (!isRecord(value)) throw new Error(`${field} must contain an object`);
	rejectUnknownKeys(value, ["configVersion", "archiveRoot", "stateRoot", "launchAgentPath", "brain", "providers", "auth"], field);
	if (
		"configVersion" in value &&
		(value.configVersion !== 1 || !Number.isInteger(value.configVersion))
	)
		throw new Error(`unsupported configuration version: ${String(value.configVersion)}`);
	const brain = value.brain;
	if (brain !== undefined && !isRecord(brain)) throw new Error(`${field}.brain must contain an object`);
	if (brain !== undefined) rejectUnknownKeys(brain, ["databasePath", "zeroEntropyBaseUrl", "zeroEntropyCollection", "zeroEntropyBatchSize", "chunkTargetChars", "chunkMaxChars", "retrievalLimit", "synthesisEvidenceLimit", "requestTimeoutMs", "retryAttempts", "retryBackoffMs", "remoteOversample", "remotePollIntervalMs", "remotePollDurationMs", "snippetChars", "questionMaxChars", "synthesisEvidenceChars", "diagnostics", "codexTimeoutMs", "synthesisCommand", "rerankerEndpoint", "rerankerModel", "generationEndpoint", "generationModel", "keychainService", "keychainAccount"], `${field}.brain`);
	const providers = value.providers;
	if (providers !== undefined && !isRecord(providers)) throw new Error(`${field}.providers must contain an object`);
	if (isRecord(providers)) {
		rejectUnknownKeys(providers, ["embedding", "reranking", "generation", "transcription", "extraction"], `${field}.providers`);
		for (const [kind, provider] of Object.entries(providers)) rejectUnknownKeys(provider, ["endpoint", "model", "privacy", "apiKey", "provider", "revision", "dimensions"], `${field}.providers.${kind}`);
	}
	const auth = value.auth;
	if (auth !== undefined && !isRecord(auth)) throw new Error(`${field}.auth must contain an object`);
	if (isRecord(auth)) {
		rejectUnknownKeys(auth, ["oauth", "session"], `${field}.auth`);
		if (isRecord(auth.oauth)) {
			rejectUnknownKeys(auth.oauth, ["allowedOrigin", "clients"], `${field}.auth.oauth`);
			if (Array.isArray(auth.oauth.clients)) for (const [index, client] of auth.oauth.clients.entries()) rejectUnknownKeys(client, ["id", "redirectUris", "allowedScopes", "confidential", "clientSecret", "tenantId"], `${field}.auth.oauth.clients.${index}`);
		}
		if (isRecord(auth.session)) rejectUnknownKeys(auth.session, ["idleMs", "absoluteMs", "secure"], `${field}.auth.session`);
	}
}

function environmentLayer(environment: Environment): Partial<Config> {
	const defaults = defaultConfig({});
	const configured = defaultConfig(environment);
	const difference = (value: unknown, baseline: unknown): unknown => {
		if (isRecord(value) && isRecord(baseline)) {
			const nested: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(value)) {
				const childDifference = difference(child, baseline[key]);
				if (childDifference !== undefined) nested[key] = childDifference;
			}
			return Object.keys(nested).length ? nested : undefined;
		}
		return JSON.stringify(value) === JSON.stringify(baseline) ? undefined : value;
	};
	const layer = difference(configured, defaults);
	if (!isRecord(layer)) return {};
	return layer as Partial<Config>;
}

function assertLoadedConfig(config: Config): void {
	if (!config.archiveRoot.trim() || !config.stateRoot.trim() || !config.launchAgentPath.trim()) throw new Error("configuration paths are required");
	const brain = config.brain;
	if (!brain || !Number.isInteger(brain.chunkTargetChars) || !Number.isInteger(brain.chunkMaxChars) || brain.chunkTargetChars < 100 || brain.chunkTargetChars > brain.chunkMaxChars || brain.chunkMaxChars > 200_000) throw new Error("configuration chunk limits are invalid");
	if (!Number.isInteger(brain.retrievalLimit) || brain.retrievalLimit < 1 || brain.retrievalLimit > 100 || !Number.isInteger(brain.synthesisEvidenceLimit) || brain.synthesisEvidenceLimit < 1 || brain.synthesisEvidenceLimit > 50 || !Number.isInteger(brain.requestTimeoutMs) || brain.requestTimeoutMs < 100 || brain.requestTimeoutMs > 300_000) throw new Error("configuration retrieval limits are invalid");
	for (const [kind, provider] of Object.entries(config.providers ?? {})) {
		if (!provider || !provider.endpoint?.trim() || !provider.model?.trim() || !["local", "hosted"].includes(provider.privacy)) throw new Error(`configuration ${kind} provider is invalid`);
		let endpoint: URL;
		try { endpoint = new URL(provider.endpoint); } catch { throw new Error(`configuration ${kind} provider endpoint is invalid`); }
		if (provider.privacy === "local" && !["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname)) throw new Error(`configuration ${kind} local provider must use a loopback endpoint`);
		if (provider.dimensions !== undefined && (!Number.isInteger(provider.dimensions) || provider.dimensions < 1 || provider.dimensions > 65_536)) throw new Error(`configuration ${kind} provider dimensions are invalid`);
		if (provider.apiKey?.includes("\n") || provider.apiKey?.includes("\r")) throw new Error(`configuration ${kind} provider key is invalid`);
	}
	const auth = config.auth;
	if (auth?.oauth?.allowedOrigin !== undefined) {
		try { const origin = new URL(auth.oauth.allowedOrigin); if (origin.pathname !== "/" || origin.search || origin.hash) throw new Error(); } catch { throw new Error("configuration OAuth origin is invalid"); }
	}
	for (const client of auth?.oauth?.clients ?? []) {
		if (!client.id.trim() || !client.redirectUris.length || client.redirectUris.some((uri) => !uri.trim() || uri.includes("#")) || !client.allowedScopes.length || client.allowedScopes.some((scope) => !["read", "write", "admin"].includes(scope)) || client.confidential && !client.clientSecret?.trim()) throw new Error("configuration OAuth client is invalid");
	}
	for (const setting of [
		{ name: "idle", value: auth?.session?.idleMs, maximum: 7 * 24 * 60 * 60_000 },
		{ name: "absolute", value: auth?.session?.absoluteMs, maximum: 30 * 24 * 60 * 60_000 },
	]) {
		if (setting.value !== undefined && (!Number.isInteger(setting.value) || setting.value < 1_000 || setting.value > setting.maximum)) throw new Error(`configuration session ${setting.name} lifetime is invalid`);
	}
}

export interface LoadConfigOptions {
	filePath?: string;
	environment?: Environment;
	explicit?: ConfigOverride;
}

export type ConfigOverride = {
	archiveRoot?: string;
	stateRoot?: string;
	launchAgentPath?: string;
	brain?: Partial<BrainConfig>;
	providers?: Partial<ProviderConfig>;
	auth?: AuthConfig;
};

export async function loadConfig(options: LoadConfigOptions = {}): Promise<Config> {
	const environment = options.environment ?? process.env;
	let file: ConfigOverride = {};
	const filePath = options.filePath ?? environment.MANAS_CONFIG_FILE;
	if (filePath) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(filePath, "utf8"));
		} catch {
			throw new Error("configuration file is not valid JSON or cannot be read");
		}
		if (!isRecord(parsed)) throw new Error("configuration file must contain an object");
		assertConfigShape(parsed, "configuration file");
		const { configVersion: _configVersion, ...configuration } = parsed;
		file = configuration as ConfigOverride;
	}
	assertConfigShape(options.explicit, "explicit configuration");
	const result = resolveConfiguration({
		defaults: defaultConfig({}) as unknown as Record<string, unknown>,
		file,
		environment: environmentLayer(environment),
		explicit: options.explicit as Record<string, unknown> | undefined,
	}) as unknown as Config;
	assertLoadedConfig(result);
	return result;
}
