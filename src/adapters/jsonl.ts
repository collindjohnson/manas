import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function walkFiles(root: string, predicate: (path: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && predicate(path)) files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

export interface JsonlResult {
  records: Array<Record<string, unknown>>;
  trailingLineIgnored: boolean;
}

export async function readJsonl(path: string): Promise<JsonlResult> {
  const text = await Bun.file(path).text();
  const lines = text.split("\n");
  const records: Array<Record<string, unknown>> = [];
  let trailingLineIgnored = false;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("record is not a JSON object");
      }
      records.push(value as Record<string, unknown>);
    } catch (error) {
      const isTrailing = index === lines.length - 1 && !text.endsWith("\n");
      if (isTrailing) {
        trailingLineIgnored = true;
        continue;
      }
      throw new Error(`${path}:${index + 1}: malformed JSONL record: ${(error as Error).message}`);
    }
  }
  return { records, trailingLineIgnored };
}
