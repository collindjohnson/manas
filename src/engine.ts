import { createHash } from "node:crypto";
import { loadConfig, type AuthConfig, type Config, type LoadConfigOptions, type OAuthClientConfig, type ProviderEndpointConfig } from "./config";
import { OAuthAuthorizationServer, QuotaLedger, SessionManager, type OAuthClient } from "./brain/oauth";
import { DurableOAuthAuthorizationServer } from "./brain/oauth-persistence";
import { BrainRepository, type BrainRepositoryOptions } from "./brain/repository";
import {
	OpenAiCompatibleEmbeddingProvider,
	OpenAiCompatibleGenerationProvider,
	OpenAiCompatibleRerankerProvider,
	OpenAiCompatibleStructuredExtractionProvider,
	OpenAiCompatibleTranscriptionProvider,
	type EmbeddingProvider,
	type GenerationProvider,
	type RerankerProvider,
	type StructuredExtractionProvider,
	type TranscriptionProvider,
} from "./brain/providers";
import { openPgliteBrainStore, type BrainStore } from "./brain/store";

export interface BrainProviderBundle {
	embedding?: EmbeddingProvider;
	reranking?: RerankerProvider;
	generation?: GenerationProvider;
	transcription?: TranscriptionProvider;
	extraction?: StructuredExtractionProvider;
}

export interface BrainAuthBundle {
	oauth: OAuthAuthorizationServer | DurableOAuthAuthorizationServer;
	sessions: SessionManager;
	quotas: QuotaLedger;
	secureSessionCookies: boolean;
}

export interface BrainEngine {
	repository: BrainRepository;
	store?: BrainStore;
	config: Config;
	providers: BrainProviderBundle;
	auth: BrainAuthBundle;
	close(): Promise<void>;
}

export interface BrainEngineOptions {
	repositoryRoot: string;
	storePath?: string;
	repositoryOptions?: BrainRepositoryOptions;
	config?: Config;
	configLoad?: LoadConfigOptions;
	providers?: Partial<BrainProviderBundle>;
	auth?: Partial<BrainAuthBundle>;
}

function hashSecret(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function endpointConfig(value: ProviderEndpointConfig | undefined): ProviderEndpointConfig | undefined {
	return value;
}

function configuredProviders(config: Config, overrides: Partial<BrainProviderBundle> = {}): BrainProviderBundle {
	const settings = config.providers ?? {};
	const legacy = config.brain;
	const reranking = settings.reranking ?? (legacy?.rerankerEndpoint && legacy.rerankerModel ? {
		endpoint: legacy.rerankerEndpoint,
		model: legacy.rerankerModel,
		privacy: "local" as const,
	} : undefined);
	const generation = settings.generation ?? (legacy?.generationEndpoint && legacy.generationModel ? {
		endpoint: legacy.generationEndpoint,
		model: legacy.generationModel,
		privacy: "local" as const,
	} : undefined);
	const providers: BrainProviderBundle = { ...overrides };
	const embedding = endpointConfig(settings.embedding);
	if (!providers.embedding && embedding) {
		if (embedding.dimensions === undefined) throw new Error("configured embedding provider dimensions are required");
		providers.embedding = new OpenAiCompatibleEmbeddingProvider({ id: embedding.model, dimensions: embedding.dimensions }, embedding.endpoint, embedding.apiKey, embedding.privacy);
	}
	if (!providers.reranking && reranking) providers.reranking = new OpenAiCompatibleRerankerProvider(reranking.model, reranking.endpoint, reranking.apiKey, reranking.privacy, { provider: reranking.provider, revision: reranking.revision });
	if (!providers.generation && generation) providers.generation = new OpenAiCompatibleGenerationProvider(generation.model, generation.endpoint, generation.apiKey, generation.privacy, { provider: generation.provider, revision: generation.revision });
	const transcription = endpointConfig(settings.transcription);
	if (!providers.transcription && transcription) providers.transcription = new OpenAiCompatibleTranscriptionProvider(transcription.model, transcription.endpoint, transcription.apiKey, transcription.privacy, { provider: transcription.provider, revision: transcription.revision });
	const extraction = endpointConfig(settings.extraction);
	if (!providers.extraction && extraction) providers.extraction = new OpenAiCompatibleStructuredExtractionProvider(extraction.model, extraction.endpoint, extraction.apiKey, extraction.privacy, { provider: extraction.provider, revision: extraction.revision });
	return providers;
}

function oauthClient(config: OAuthClientConfig): OAuthClient & { tenantId?: string } {
	return {
		id: config.id,
		redirectUris: [...config.redirectUris],
		allowedScopes: [...config.allowedScopes],
		confidential: config.confidential,
		...(config.clientSecret ? { secretHash: hashSecret(config.clientSecret) } : {}),
		...(config.tenantId ? { tenantId: config.tenantId } : {}),
	};
}

async function configuredAuth(config: Config, store: BrainStore | undefined, overrides: Partial<BrainAuthBundle> = {}): Promise<BrainAuthBundle> {
	const oauth = overrides.oauth ?? (store ? new DurableOAuthAuthorizationServer(store) : new OAuthAuthorizationServer());
	for (const client of config.auth?.oauth?.clients ?? []) await oauth.registerClient(oauthClient(client));
	return {
		oauth,
		sessions: overrides.sessions ?? new SessionManager({ idleMs: config.auth?.session?.idleMs, absoluteMs: config.auth?.session?.absoluteMs }),
		quotas: overrides.quotas ?? new QuotaLedger(),
		secureSessionCookies: overrides.secureSessionCookies ?? config.auth?.session?.secure ?? true,
	};
}

export async function createBrainEngine(options: BrainEngineOptions): Promise<BrainEngine> {
	if (!options.repositoryRoot.trim()) throw new Error("brain engine repository root is required");
	if (options.config && options.configLoad) throw new Error("provide either config or configLoad, not both");
	const config = options.config ?? await loadConfig(options.configLoad);
	const repository = new BrainRepository(options.repositoryRoot, options.repositoryOptions);
	await repository.initialize();
	const store = options.storePath ? await openPgliteBrainStore(options.storePath) : undefined;
	try {
		const providers = configuredProviders(config, options.providers);
		const auth = await configuredAuth(config, store, options.auth);
		return { repository, ...(store ? { store } : {}), config, providers, auth, close: async () => { await store?.close(); } };
	} catch (error) {
		await store?.close();
		throw error;
	}
}

/** Loads a config file/env layer before constructing all configured runtime services. */
export async function createConfiguredBrainEngine(options: Omit<BrainEngineOptions, "config" | "configLoad"> & { config?: LoadConfigOptions }): Promise<BrainEngine> {
	const { config: configLoad, ...rest } = options;
	return createBrainEngine({ ...rest, configLoad });
}
