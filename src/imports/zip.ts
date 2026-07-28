import { basename, posix } from "node:path";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRIES = 256;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_NESTING = 16;

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export interface ZipLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxNesting?: number;
}

function u16(view: DataView, offset: number): number { return view.getUint16(offset, true); }
function u32(view: DataView, offset: number): number { return view.getUint32(offset, true); }

function validateEntryName(name: string, maxNesting: number): void {
  const normalizedName = name.replaceAll("\\", "/");
  const parts = normalizedName.split("/");
  if (name.startsWith("/") || parts.some((part) => part === "..")) {
    throw new Error(`ZIP entry escapes extraction root: ${name}`);
  }
  if (name.includes("\0")) throw new Error(`ZIP entry contains NUL: ${name}`);
  if (parts.filter((part) => part && part !== ".").length > maxNesting) throw new Error(`ZIP entry nesting limit exceeded: ${name}`);
  if (posix.normalize(normalizedName).startsWith("../")) throw new Error(`ZIP entry escapes extraction root: ${name}`);
}

function isSymlink(view: DataView, offset: number): boolean {
  const versionMadeBy = u16(view, offset + 4);
  const platform = versionMadeBy >>> 8;
  const externalAttributes = u32(view, offset + 38);
  return platform === 3 && ((externalAttributes >>> 16) & 0xf000) === 0xa000;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(path: string, limits?: ZipLimits): Promise<ZipEntry[]> {
  return readZipBytes(new Uint8Array(await Bun.file(path).arrayBuffer()), limits);
}

export async function readZipBytes(bytes: Uint8Array, limits: ZipLimits = {}): Promise<ZipEntry[]> {
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  const maxEntryBytes = limits.maxEntryBytes ?? MAX_ENTRY_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const maxNesting = limits.maxNesting ?? MAX_NESTING;
  if (![maxEntries, maxEntryBytes, maxTotalBytes, maxNesting].every((value) => Number.isInteger(value) && value >= 1)) throw new Error("invalid ZIP limits");
  if (maxEntryBytes > maxTotalBytes || maxEntries > 65_535) throw new Error("invalid ZIP limits");
  if (bytes.length < 22) throw new Error("invalid ZIP: archive is too small");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (u32(view, offset) === EOCD) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("invalid ZIP: end-of-central-directory record not found");
  const entriesCount = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  if (entriesCount > maxEntries) throw new Error(`ZIP contains too many entries: ${entriesCount}`);
  if (centralOffset > bytes.length || centralSize > bytes.length - centralOffset) throw new Error("invalid ZIP central directory bounds");
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entriesCount; index += 1) {
    if (offset > bytes.length || 46 > bytes.length - offset || offset + 46 > centralOffset + centralSize) throw new Error(`invalid ZIP central directory bounds at entry ${index}`);
    if (u32(view, offset) !== CENTRAL) throw new Error(`invalid ZIP central directory entry ${index}`);
    const flags = u16(view, offset + 8);
    const method = u16(view, offset + 10);
    const compressedSize = u32(view, offset + 20);
    const uncompressedSize = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    if (nameLength > bytes.length - offset - 46 || 46 + nameLength + extraLength + commentLength > centralOffset + centralSize - offset) throw new Error(`invalid ZIP central directory entry bounds: ${index}`);
    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder().decode(nameBytes);
    validateEntryName(name, maxNesting);
    if (flags & 1) throw new Error(`encrypted ZIP entry is not supported: ${name}`);
    if (isSymlink(view, offset)) throw new Error(`symlink ZIP entry is not supported: ${name}`);
    if (uncompressedSize > maxEntryBytes || totalBytes > maxTotalBytes - uncompressedSize) {
      throw new Error(`ZIP extracted-size limit exceeded: ${name}`);
    }
    if (localOffset > bytes.length || 30 > bytes.length - localOffset || u32(view, localOffset) !== LOCAL) throw new Error(`invalid ZIP local header: ${name}`);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    if (localNameLength > bytes.length - localOffset - 30 || localExtraLength > bytes.length - localOffset - 30 - localNameLength) throw new Error(`invalid ZIP local header bounds: ${name}`);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (compressedSize > bytes.length - dataStart) throw new Error(`invalid ZIP data bounds: ${name}`);
    const dataEnd = dataStart + compressedSize;
    const compressed = bytes.slice(dataStart, dataEnd);
    let data: Uint8Array;
    if (method === 0) data = compressed;
    else if (method === 8) data = await inflate(compressed);
    else throw new Error(`unsupported ZIP compression method ${method}: ${name}`);
    if (data.length !== uncompressedSize) throw new Error(`ZIP size mismatch: ${name}`);
    totalBytes += data.length;
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function readExportJson(path: string): Promise<Array<{ name: string; value: unknown }>> {
  if (!path.toLowerCase().endsWith(".zip")) {
    return [{ name: basename(path), value: await Bun.file(path).json() }];
  }
  const entries = await readZip(path);
  const jsonEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith(".json"));
  return jsonEntries.map((entry) => ({ name: entry.name, value: JSON.parse(new TextDecoder().decode(entry.data)) as unknown }));
}
