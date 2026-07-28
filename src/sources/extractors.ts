import { lstat, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createHash } from "node:crypto";
import type { ExtractedContent, Extractor, ExtractorInput } from "./types";
import { readZipBytes } from "../imports/zip";
import type { TranscriptionProvider } from "../brain/providers";

export type { ExtractedContent, Extractor, ExtractorInput } from "./types";

const textExtensions = new Set([".md", ".markdown", ".txt", ".json", ".csv", ".log"]);
const officeExtensions = new Set([".docx", ".xlsx", ".pptx"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tif", ".tiff"]);
const audioExtensions = new Set([".mp3", ".wav", ".m4a", ".ogg", ".flac"]);

function hashed(markdown: string): string {
	return createHash("sha256").update(markdown).digest("hex");
}

function heading(path: string, body: string): string {
	return "# " + basename(path) + "\n\n" + body.trim() + "\n";
}

function sniffMime(bytes: Uint8Array, path: string): string {
	const extension = extname(path).toLowerCase();
	if (bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") return "application/pdf";
	if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return officeExtensions.has(extension) ? "application/vnd.openxmlformats-officedocument" : "application/zip";
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return audioExtensions.has(extension) ? "audio/wav" : "application/octet-stream";
	if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";
	if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
	if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return "audio/flac";
	if (textExtensions.has(extension)) return extension === ".json" ? "application/json" : "text/plain";
	return "application/octet-stream";
}

function xmlText(xml: string): string {
	return xml
		.replace(/<w:tab\s*\/>/g, "\t")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
		.replace(/\s+/g, " ").trim();
}

function officeBody(path: string, entries: Array<{ name: string; data: Uint8Array }>): string {
	const wanted = entries.filter((entry) => {
		const name = entry.name.toLowerCase();
		return name === "word/document.xml" || name === "xl/sharedstrings.xml" || name.startsWith("xl/worksheets/") || name.startsWith("ppt/slides/");
	});
	const parts = wanted.map((entry) => xmlText(new TextDecoder().decode(entry.data))).filter(Boolean);
	if (!parts.length) throw new Error("Office document contains no supported text parts");
	return heading(path, parts.join("\n\n"));
}

export class PlainTextExtractor implements Extractor {
	readonly id = "plain-text";
	supports(path: string, mimeType?: string): boolean {
		return textExtensions.has(extname(path).toLowerCase()) || mimeType?.startsWith("text/") === true || mimeType === "application/json";
	}
	async extract(input: ExtractorInput): Promise<ExtractedContent> {
		if (!this.supports(input.path, input.mimeType)) throw new Error("unsupported extraction format");
		if (input.bytes.includes(0)) throw new Error("binary input is not supported by the text extractor");
		const content = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
		const markdown = extname(input.path).toLowerCase() === ".md" || extname(input.path).toLowerCase() === ".markdown" ? content : `# ${basename(input.path)}\n\n${content}\n`;
		return { markdown, metadata: { extractor: this.id }, contentHash: createHash("sha256").update(markdown).digest("hex") };
	}
}

export class PdfExtractor implements Extractor {
	readonly id = "pdf";
	supports(path: string, mimeType?: string): boolean {
		return extname(path).toLowerCase() === ".pdf" && (mimeType === undefined || mimeType === "application/pdf");
	}
	async extract(input: ExtractorInput): Promise<ExtractedContent> {
		if (!this.supports(input.path, input.mimeType)) throw new Error("unsupported extraction format");
		if (sniffMime(input.bytes, input.path) !== "application/pdf") throw new Error("input is not a valid PDF");
		const raw = new TextDecoder("latin1").decode(input.bytes);
		const strings = [...raw.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((match) => match[1]!.replace(/\\([\\()])/g, "$1").replaceAll("\\n", "\n")).filter(Boolean);
		const markdown = heading(input.path, strings.join(" "));
		return { markdown, metadata: { extractor: this.id, format: "pdf" }, contentHash: hashed(markdown) };
	}
}

export class OfficeDocumentExtractor implements Extractor {
	readonly id = "office-open-xml";
	supports(path: string, mimeType?: string): boolean {
		return officeExtensions.has(extname(path).toLowerCase()) && (mimeType === undefined || mimeType === "application/vnd.openxmlformats-officedocument");
	}
	async extract(input: ExtractorInput): Promise<ExtractedContent> {
		if (!this.supports(input.path, input.mimeType)) throw new Error("unsupported extraction format");
		if (sniffMime(input.bytes, input.path) !== "application/vnd.openxmlformats-officedocument") throw new Error("input is not a valid Office Open XML document");
		const markdown = officeBody(input.path, await readZipBytes(input.bytes));
		return { markdown, metadata: { extractor: this.id, format: extname(input.path).slice(1).toLowerCase() }, contentHash: hashed(markdown) };
	}
}

export class ArchiveMetadataExtractor implements Extractor {
	readonly id = "safe-archive-metadata";
	supports(path: string, mimeType?: string): boolean {
		return extname(path).toLowerCase() === ".zip" && mimeType === "application/zip";
	}
	async extract(input: ExtractorInput): Promise<ExtractedContent> {
		if (!this.supports(input.path, input.mimeType)) throw new Error("unsupported extraction format");
		const entries = await readZipBytes(input.bytes);
		const markdown = heading(input.path, "Archive source retained externally.\n\n- Entries: " + entries.length);
		return { markdown, metadata: { extractor: this.id, entries: String(entries.length) }, contentHash: hashed(markdown) };
	}
}

export class BinaryMetadataExtractor implements Extractor {
	readonly id = "binary-metadata";
	supports(path: string, mimeType?: string): boolean {
		return Boolean(mimeType) && mimeType !== "application/pdf" && mimeType !== "application/vnd.openxmlformats-officedocument" && !textExtensions.has(extname(path).toLowerCase()) && !officeExtensions.has(extname(path).toLowerCase()) && ![".pdf", ".zip"].includes(extname(path).toLowerCase());
	}
	async extract(input: ExtractorInput): Promise<ExtractedContent> {
		if (!this.supports(input.path, input.mimeType)) throw new Error("unsupported extraction format");
		const extension = extname(input.path).slice(1).toLowerCase() || "unknown";
		const markdown = heading(input.path, "Binary source retained externally.\n\n- Format: " + extension + "\n- Bytes: " + input.bytes.byteLength);
		return { markdown, metadata: { extractor: this.id, format: extension, bytes: String(input.bytes.byteLength) }, contentHash: hashed(markdown) };
	}
}

export interface LocalOcrProvider {
	recognize(image: Uint8Array, mimeType: string): Promise<string>;
}

export interface ExtractionQuarantine {
	record(event: { path: string; extractor: string; reason: string }): Promise<void>;
}

export function createAuditExtractionQuarantineSink(store: { query<T extends Record<string, unknown>>(sql: string, parameters?: Array<string | number | boolean | null | Uint8Array>): Promise<T[]> }, tenantId = "local"): ExtractionQuarantine {
	if (!tenantId.trim()) throw new Error("extraction quarantine tenant is required");
	return { record: async (event) => {
		const auditModule = await import(["..", "brain", "audit"].join(String.fromCharCode(47)));
		await auditModule.recordAuditEvent(store, { tenantId, action: "extraction.quarantined", subjectId: event.path, metadata: { extractor: event.extractor, reason: event.reason } });
	} };
}

const highConfidenceSecretPatterns: Array<[string, RegExp]> = [
	["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
	["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
	["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
	["OpenAI-style token", /\b(?:sk|rk)-(?:live|proj)-[A-Za-z0-9_-]{20,}\b/],
];

export function detectHighConfidenceSecret(value: string): string | undefined {
	return highConfidenceSecretPatterns.find(([, pattern]) => pattern.test(value))?.[0];
}

export class ImageOcrExtractor implements Extractor {
	readonly id = "local-ocr";
	constructor(private readonly provider?: LocalOcrProvider) {}
	supports(path: string, mimeType?: string): boolean {
		return Boolean(this.provider) && imageExtensions.has(extname(path).toLowerCase()) && Boolean(mimeType?.startsWith("image/"));
	}
	async extract(input: ExtractorInput): Promise<ExtractedContent> {
		if (!this.supports(input.path, input.mimeType)) throw new Error(this.provider ? "unsupported image extraction format" : "local OCR provider is not configured");
		const text = await this.provider!.recognize(input.bytes, input.mimeType!);
		if (!text.trim()) throw new Error("local OCR provider returned empty output");
		const markdown = heading(input.path, text);
		return { markdown, metadata: { extractor: this.id, model: "local-ocr" }, contentHash: hashed(markdown) };
	}
}

export class AudioTranscriptionExtractor implements Extractor {
	readonly id = "local-transcription";
	constructor(private readonly provider?: TranscriptionProvider) {}
	supports(path: string, mimeType?: string): boolean {
		return Boolean(this.provider) && audioExtensions.has(extname(path).toLowerCase()) && Boolean(mimeType?.startsWith("audio/"));
	}
	async extract(input: ExtractorInput): Promise<ExtractedContent> {
		if (!this.supports(input.path, input.mimeType)) throw new Error(this.provider ? "unsupported audio extraction format" : "local transcription provider is not configured");
		const text = await this.provider!.transcribe(input.bytes, input.mimeType);
		if (!text.trim()) throw new Error("local transcription provider returned empty output");
		const markdown = heading(input.path, text);
		return { markdown, metadata: { extractor: this.id, model: this.provider!.id }, contentHash: hashed(markdown) };
	}
}

export async function extractLocalFile(path: string, extractors: Extractor[] = [new PlainTextExtractor(), new PdfExtractor(), new OfficeDocumentExtractor(), new ArchiveMetadataExtractor(), new BinaryMetadataExtractor()], maximumBytes = 20 * 1024 * 1024, quarantine?: ExtractionQuarantine, schemaPack?: { id: string; version: string }): Promise<ExtractedContent> {
	if (!Number.isInteger(maximumBytes) || maximumBytes < 1) throw new Error("invalid extraction size limit");
	if (schemaPack && (!schemaPack.id.trim() || !schemaPack.version.trim())) throw new Error("extraction schema pack is invalid");
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("extraction input must be a regular file");
	if (info.size > maximumBytes) throw new Error("extraction input exceeds size limit");
	const bytes = await readFile(path);
	const mimeType = sniffMime(bytes, path);
	const extractor = extractors.find((candidate) => candidate.supports(path, mimeType));
	if (!extractor) throw new Error("unsupported extraction format");
	const extracted = await extractor.extract({ path, bytes, mimeType });
	const secret = detectHighConfidenceSecret(extracted.markdown);
	if (secret) {
		await quarantine?.record({ path, extractor: extractor.id, reason: secret });
		throw new Error("extracted content contains a high-confidence credential and was quarantined");
	}
	return schemaPack ? { ...extracted, metadata: { ...(extracted.metadata ?? {}), schemaPackId: schemaPack.id, schemaPackVersion: schemaPack.version } } : extracted;
}
