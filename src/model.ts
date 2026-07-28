export const PROVIDERS = [
	"claude_code",
	"codex",
	"pi",
	"cursor",
	"grok",
	"chatgpt",
	"claude",
] as const;

export type Provider = (typeof PROVIDERS)[number];

export type MessageRole = "user" | "assistant";

export interface TranscriptMessage {
	role: MessageRole;
	text: string;
	timestamp?: string;
}

export interface Conversation {
	provider: Provider;
	sourceId: string;
	sourcePath: string;
	title: string;
	createdAt?: string;
	updatedAt?: string;
	workspacePath?: string;
	project?: string;
	repository?: string;
	repositoryUrl?: string;
	repoKey?: string;
	messages: TranscriptMessage[];
	redactions: number;
	fingerprint: string;
}

export interface AdapterWarning {
	provider: Provider | string;
	sourcePath?: string;
	message: string;
}

export interface AdapterResult {
	provider: Provider;
	conversations: Conversation[];
	scanned: number;
	warnings: AdapterWarning[];
	failures: AdapterWarning[];
}

export interface ArchiveDocument {
	path: string;
	provider: Provider | string;
	nessieId: string;
	sourceId?: string;
	sourcePath?: string;
	title?: string;
	sourceUpdatedAt?: string;
	syncFingerprint?: string;
	frontmatter: string;
	body: string;
	bodyHash: string;
}

export interface SyncTotals {
	scanned: number;
	created: number;
	updated: number;
	skipped: number;
	redacted: number;
	warnings: number;
	failures: number;
}

export interface SyncReport {
	totals: SyncTotals;
	providers: Record<string, SyncTotals>;
	warnings: AdapterWarning[];
	failures: AdapterWarning[];
}

export type EmbeddingInputType = "document" | "query";
export type SearchMode = "hybrid" | "keyword" | "semantic";

export interface BrainDocument {
	nessieId: string;
	relativePath: string;
	provider: string;
	kind?: string;
	sourceId?: string;
	sourcePath?: string;
	title?: string;
	project?: string;
	repository?: string;
	workspace?: string;
	createdAt?: string;
	updatedAt?: string;
	frontmatterHash: string;
	bodyHash: string;
}

export interface BrainChunk {
	id: string;
	documentId: string;
	ordinal: number;
	role?: MessageRole;
	startOffset: number;
	endOffset: number;
	text: string;
	textHash: string;
	contextualPrefix: string;
	sizeEstimate: number;
}

export interface SearchFilters {
	provider?: string;
	project?: string;
	repository?: string;
	workspace?: string;
	role?: MessageRole;
	after?: string;
	before?: string;
}

export interface SearchOptions extends SearchFilters {
	limit?: number;
	mode?: SearchMode;
	explain?: boolean;
}

export interface GraphContribution {
	type: "project" | "repository" | "workspace" | "source_path";
	sharedWith: string;
	score: number;
}

export interface SearchExplanation {
	lexicalRank?: number;
	semanticRank?: number;
	unboostedScore: number;
	graphBoost: number;
	graphContributions?: GraphContribution[];
	degradation?: string;
}

export interface SearchOutcome {
	results: SearchResult[];
	requestedMode: SearchMode;
	effectiveMode:
		| "hybrid"
		| "keyword"
		| "semantic"
		| "keyword-degraded"
		| "unavailable";
	degraded: boolean;
	diagnostics: string[];
}

export interface SearchResult {
	nessieId: string;
	path: string;
	title?: string;
	provider: string;
	chunkId: string;
	text: string;
	score: number;
	lexicalScore?: number;
	semanticScore?: number;
	degraded?: boolean;
	degradedReason?: string;
	explain?: SearchExplanation;
}
