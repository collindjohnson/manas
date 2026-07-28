export interface SourceProvenance {
	sourceType: string;
	sourcePath?: string;
	retrievedAt: string;
	metadata?: Record<string, string>;
}

export interface SourceCompatibility {
	minimumEngine?: string;
	maximumEngine?: string;
}

export interface SourceDescriptor {
	id: string;
	version: string;
	kind: string;
	trusted: boolean;
	compatibility?: SourceCompatibility;
}

export interface SourceCheckpoint {
	updatedAt?: string;
	cursor?: string;
}

export interface NormalizedDocument {
	externalId: string;
	suggestedPath: string;
	content: string;
	provenance: SourceProvenance;
	deleted: boolean;
	contentHash?: string;
	extractionMetadata?: Record<string, string>;
	updatedAt?: string;
	externalRevision?: string;
	visibilityLabels?: string[];
	managedSections?: string[];
}

export interface SourceAdapter {
	id: string;
	describe?(): SourceDescriptor;
	list?(): Promise<NormalizedDocument[]>;
	scan?(checkpoint?: SourceCheckpoint): AsyncIterable<NormalizedDocument>;
	checkpoint?(): SourceCheckpoint;
}

export interface StreamingSourceAdapter {
	describe(): SourceDescriptor;
	scan(checkpoint?: SourceCheckpoint): AsyncIterable<NormalizedDocument>;
}

export interface ExtractedContent {
	markdown: string;
	metadata?: Record<string, string>;
	contentHash?: string;
}

export interface ExtractorInput {
	path: string;
	bytes: Uint8Array;
	mimeType?: string;
}

export interface Extractor {
	id: string;
	supports(path: string, mimeType?: string): boolean;
	extract(input: ExtractorInput): Promise<ExtractedContent>;
}
