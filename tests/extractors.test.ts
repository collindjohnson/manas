import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modulePath = ["..", "src", "sources", "extractors"].join(String.fromCharCode(47));
const { AudioTranscriptionExtractor, ImageOcrExtractor, PlainTextExtractor, createAuditExtractionQuarantineSink, detectHighConfidenceSecret, extractLocalFile } = await import(modulePath);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("local extraction", () => {
	test("converts bounded regular text files into Markdown", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-extract-"));
		roots.push(root);
		const path = join(root, "note.txt");
		await writeFile(path, "hello");
		await expect(extractLocalFile(path, undefined, 20 * 1024 * 1024, undefined, { id: "legacy", version: "1" })).resolves.toMatchObject({ markdown: "# note.txt\n\nhello\n", metadata: { extractor: "plain-text", schemaPackId: "legacy", schemaPackVersion: "1" }, contentHash: expect.any(String) });
		expect(new PlainTextExtractor().supports("note.pdf")).toBe(false);
	});

	test("rejects symlinks, binary data, and unsupported formats", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-extract-"));
		roots.push(root);
		const text = join(root, "note.txt");
		const binary = join(root, "binary.txt");
		const unsupported = join(root, "file.pdf");
		await writeFile(text, "safe");
		await writeFile(binary, new Uint8Array([1, 0, 2]));
		await writeFile(unsupported, "not a PDF");
		await symlink(text, join(root, "link.txt"));
		await expect(extractLocalFile(join(root, "link.txt"))).rejects.toThrow("regular file");
		await expect(extractLocalFile(binary)).rejects.toThrow("binary input");
		await expect(extractLocalFile(unsupported)).rejects.toThrow("unsupported extraction format");
	});

	test("extracts bounded PDF text and retains safe metadata for other binary formats", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-extract-formats-"));
		roots.push(root);
		const pdf = join(root, "brief.pdf");
		const image = join(root, "pixel.png");
		await writeFile(pdf, "%PDF-1.4\n1 0 obj\n(Hello from PDF)\nendobj\n%%EOF");
		await writeFile(image, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		await expect(extractLocalFile(pdf)).resolves.toMatchObject({ markdown: "# brief.pdf\n\nHello from PDF\n", metadata: { extractor: "pdf" }, contentHash: expect.any(String) });
		await expect(extractLocalFile(image)).resolves.toMatchObject({ metadata: { extractor: "binary-metadata", format: "png" }, markdown: expect.stringContaining("Bytes: 8") });
	});

	test("uses explicitly configured local OCR and transcription providers", async () => {
		const ocr = new ImageOcrExtractor({ recognize: async () => "recognized diagram" });
		const audio = new AudioTranscriptionExtractor({ id: "local-audio", transcribe: async () => "spoken words" });
		const imageInput = { path: "diagram.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mimeType: "image/png" };
		const audioInput = { path: "memo.mp3", bytes: new Uint8Array([0x49, 0x44, 0x33]), mimeType: "audio/mpeg" };
		await expect(ocr.extract(imageInput)).resolves.toMatchObject({ markdown: "# diagram.png\n\nrecognized diagram\n", metadata: { extractor: "local-ocr" } });
		await expect(audio.extract(audioInput)).resolves.toMatchObject({ markdown: "# memo.mp3\n\nspoken words\n", metadata: { extractor: "local-transcription", model: "local-audio" } });
	});

		test("quarantines high-confidence credentials before extracted content can be committed", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-extract-secret-"));
		roots.push(root);
		const path = join(root, "secret.txt");
		const privateKey = ["-----BEGIN ", "PRIVATE KEY-----\nnot committed\n-----END ", "PRIVATE KEY-----"].join("");
		await writeFile(path, privateKey);
		const events: unknown[] = [];
		expect(detectHighConfidenceSecret(["AKIA", "1234567890ABCDEF"].join(""))).toBe("AWS access key");
		await expect(extractLocalFile(path, undefined, 20 * 1024 * 1024, { record: async (event: unknown) => { events.push(event); } })).rejects.toThrow("quarantined");
		expect(events).toMatchObject([{ path, extractor: "plain-text", reason: "private key" }]);
	});

	test("provides a tenant-scoped audit sink for extracted credentials", async () => {
		const calls: unknown[][] = [];
		const store = { query: async (_sql: string, parameters?: unknown[]) => { calls.push(parameters ?? []); return [{ id: "event", tenant_id: "tenant", action: "extraction.quarantined", subject_id: "secret.txt", metadata: parameters?.[4], created_at: "2026-07-27T00:00:00.000Z" }]; } };
		await createAuditExtractionQuarantineSink(store as never, "tenant").record({ path: "secret.txt", extractor: "plain-text", reason: "private key" });
		expect(calls[0]?.slice(1, 4)).toEqual(["tenant", "extraction.quarantined", "secret.txt"]);
		expect(calls[0]?.[4]).toContain("private key");
	});

});
