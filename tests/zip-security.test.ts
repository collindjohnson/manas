import { describe, expect, test } from "bun:test";
import { readZipBytes } from "../src/imports/zip";

function storedZip(name: string, content: string, options: { encrypted?: boolean; symlink?: boolean } = {}): Uint8Array {
	const encoder = new TextEncoder();
	const nameBytes = encoder.encode(name);
	const data = encoder.encode(content);
	const out = new Uint8Array(30 + nameBytes.length + data.length + 46 + nameBytes.length + 22);
	const view = new DataView(out.buffer);
	let offset = 0;
	view.setUint32(offset, 0x04034b50, true);
	view.setUint16(offset + 6, options.encrypted ? 1 : 0, true);
	view.setUint16(offset + 10, 0, true);
	view.setUint32(offset + 18, data.length, true);
	view.setUint32(offset + 22, data.length, true);
	view.setUint16(offset + 26, nameBytes.length, true);
	out.set(nameBytes, offset + 30);
	out.set(data, offset + 30 + nameBytes.length);
	offset += 30 + nameBytes.length + data.length;
	const centralOffset = offset;
	view.setUint32(offset, 0x02014b50, true);
	view.setUint16(offset + 4, options.symlink ? 0x0314 : 20, true);
	view.setUint16(offset + 8, options.encrypted ? 1 : 0, true);
	view.setUint16(offset + 10, 0, true);
	view.setUint32(offset + 20, data.length, true);
	view.setUint32(offset + 24, data.length, true);
	view.setUint16(offset + 28, nameBytes.length, true);
	if (options.symlink) view.setUint32(offset + 38, 0xa0000000, true);
	view.setUint32(offset + 42, 0, true);
	out.set(nameBytes, offset + 46);
	offset += 46 + nameBytes.length;
	view.setUint32(offset, 0x06054b50, true);
	view.setUint16(offset + 8, 1, true);
	view.setUint16(offset + 10, 1, true);
	view.setUint32(offset + 12, 46 + nameBytes.length, true);
	view.setUint32(offset + 16, centralOffset, true);
	return out;
}

describe("bounded ZIP parsing", () => {
	test("honors caller limits and rejects nested traversal", async () => {
		const archive = storedZip("one.txt", "12345");
		await expect(readZipBytes(archive, { maxEntryBytes: 4 })).rejects.toThrow("extracted-size limit");
		await expect(readZipBytes(storedZip("a/b/c.txt", "ok"), { maxNesting: 2 })).rejects.toThrow("nesting limit");
		await expect(readZipBytes(storedZip("folder/../escape.txt", "no"))).rejects.toThrow("escapes extraction root");
	});

	test("rejects encrypted and symlink entries before exposing bytes", async () => {
		await expect(readZipBytes(storedZip("secret.txt", "no", { encrypted: true }))).rejects.toThrow("encrypted");
		await expect(readZipBytes(storedZip("link.txt", "target", { symlink: true }))).rejects.toThrow("symlink");
	});

	test("rejects truncated central-directory and local-header bounds", async () => {
		const archive = storedZip("note.txt", "ok");
		await expect(readZipBytes(archive.slice(0, archive.length - 3))).rejects.toThrow(/central directory|end-of-central/);
		const local = storedZip("note.txt", "ok");
		new DataView(local.buffer).setUint32(30 + "note.txt".length + 2 + 20, 999, true);
		await expect(readZipBytes(local)).rejects.toThrow("data bounds");
	});
});
