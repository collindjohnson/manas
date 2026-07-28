import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { ArchiveDocument } from "./model";
import { parseFrontmatter, type ArchiveScan } from "./archive";

const PROVIDER_FOLDERS = ["claude", "codex", "pi", "cursor", "grok", "chatgpt", "profile", "contexts", "nessie", "obsidian"];

function value(document: ArchiveDocument, key: string): string {
  const parsed = parseFrontmatter(document.frontmatter);
  const entry = parsed?.values[key];
  return entry === null || entry === undefined ? "" : String(entry);
}
function escapeCell(valueToEscape: string): string {
  return valueToEscape.replaceAll("|", "\\|").replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll("\n", " ").trim();
}

function folderFor(root: string, path: string): string {
  return relative(root, path).split(sep)[0] || dirname(path).split(sep).at(-1) || "unknown";
}

function documentLink(root: string, document: ArchiveDocument, folder: string): string {
  const path = relative(join(root, folder), document.path).replaceAll(sep, "/").replaceAll("(", "%28").replaceAll(")", "%29");
  return `[${escapeCell(document.title ?? basename(document.path))}](${path})`;
}

function renderProviderIndex(root: string, folder: string, documents: ArchiveDocument[]): string {
  const rows = documents
    .sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "") || left.path.localeCompare(right.path))
    .map((document) => `| ${documentLink(root, document, folder)} | \`${escapeCell(value(document, "kind"))}\` | ${escapeCell(value(document, "project")) || ""} | ${escapeCell(value(document, "repository")) || ""} |`)
    .join("\n");
  return [
    `# Chat History / ${folder}`,
    "",
    `Documents: **${documents.length}**`,
    "",
    "| Document | Kind | Project | Repository |",
    "| --- | --- | --- | --- |",
    rows || "| _No conversations_ | | | |",
    "",
  ].join("\n");
}

function renderRootIndex(root: string, grouped: Map<string, ArchiveDocument[]>): string {
  const rows = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([folder, documents]) => `| [${folder}](${folder}/INDEX.md) | ${documents.length} |`)
    .join("\n");
  return [
    "# Chat History Archive",
    "",
    "One UUID-keyed document copy per source conversation, routed by provider. Sync is additive and preserves established document IDs and filenames.",
    "",
    "| Folder | Documents |",
    "| --- | ---: |",
    rows,
    "",
  ].join("\n");
}

export async function regenerateIndexes(root: string, scan: ArchiveScan): Promise<void> {
  const grouped = new Map<string, ArchiveDocument[]>();
  for (const document of scan.documents) {
    const folder = folderFor(root, document.path);
    const current = grouped.get(folder) ?? [];
    current.push(document);
    grouped.set(folder, current);
  }
  if (!grouped.has("grok")) grouped.set("grok", []);
  for (const folder of PROVIDER_FOLDERS) {
    if (!grouped.has(folder)) continue;
    await mkdir(join(root, folder), { recursive: true, mode: 0o700 });
    await writeFile(join(root, folder, "INDEX.md"), renderProviderIndex(root, folder, grouped.get(folder) ?? []), { mode: 0o600 });
  }
  await writeFile(join(root, "INDEX.md"), renderRootIndex(root, grouped), { mode: 0o600 });
}
