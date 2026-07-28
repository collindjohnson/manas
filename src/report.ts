import { chmod, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { SyncReport } from "./model";
import { isHiddenArchiveEntry, scanArchive } from "./archive";
import { redactSecrets } from "./utils";

function totalsLine(label: string, totals: SyncReport["totals"]): string {
  return `| ${label} | ${totals.scanned} | ${totals.created} | ${totals.updated} | ${totals.skipped} | ${totals.redacted} | ${totals.warnings} | ${totals.failures} |`;
}

export function renderSyncReport(report: SyncReport): string {
  const providers = Object.entries(report.providers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, totals]) => totalsLine(provider, totals))
    .join("\n");
  return [
    "# Chat History Sync Report",
    "",
    "This report is regenerated after each sync. It intentionally contains no run date so links and diffs remain stable.",
    "",
    "| Scope | Scanned | Created | Updated | Skipped | Redacted | Warnings | Failures |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    totalsLine("total", report.totals),
    providers,
    "",
    "## Warnings",
    "",
    ...(report.warnings.length ? report.warnings.map((warning) => `- [${warning.provider}] ${warning.sourcePath ? `${warning.sourcePath}: ` : ""}${warning.message}`) : ["- None"]),
    "",
    "## Failures",
    "",
    ...(report.failures.length ? report.failures.map((failure) => `- [${failure.provider}] ${failure.sourcePath ? `${failure.sourcePath}: ` : ""}${failure.message}`) : ["- None"]),
    "",
  ].join("\n");
}

export interface VerificationResult {
  ok: boolean;
  documents: number;
  ids: number;
  errors: string[];
  warnings: string[];
}

async function checkModes(root: string, errors: string[]): Promise<void> {
  const rootMode = (await stat(root)).mode & 0o777;
  if (rootMode !== 0o700) errors.push(`${root}: expected mode 0700, got ${rootMode.toString(8)}`);
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (isHiddenArchiveEntry(entry.name)) continue;
      const path = join(directory, entry.name);
      const mode = (await stat(path)).mode & 0o777;
      if (entry.isDirectory()) {
        if (mode !== 0o700) errors.push(`${path}: expected directory mode 0700, got ${mode.toString(8)}`);
        await visit(path);
      } else if (mode !== 0o600 && entry.name !== ".DS_Store" && !entry.name.endsWith(".plist")) {
        errors.push(`${path}: expected file mode 0600, got ${mode.toString(8)}`);
      }
    }
  }
  await visit(root);
}

async function checkIndexLinks(root: string, errors: string[]): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (isHiddenArchiveEntry(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === "INDEX.md") {
        const text = await readFile(path, "utf8");
        for (const match of text.matchAll(/(?<!\\)\]\(([^)]+\.md)\)/g)) {
          const target = join(directory, decodeURIComponent(match[1]));
          try { await stat(target); } catch { errors.push(`${path}: broken index link ${match[1]}`); }
        }
      }
    }
  }
  await visit(root);
}

export async function verifyArchive(root: string): Promise<VerificationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const scan = await scanArchive(root);
  errors.push(...scan.warnings);
  const ids = new Set<string>();
  for (const document of scan.documents) {
    if (ids.has(document.nessieId)) errors.push(`duplicate nessie_id ${document.nessieId}`);
    ids.add(document.nessieId);
    if (!document.path.endsWith(`${document.nessieId}.md`)) warnings.push(`${relative(root, document.path)}: filename does not end in Nessie ID`);
    if (redactSecrets(document.body).count) errors.push(`${relative(root, document.path)}: credential pattern found in body`);
    if (!document.body.endsWith("\n")) warnings.push(`${relative(root, document.path)}: body does not end with newline`);
  }
  await checkIndexLinks(root, errors);
  await checkModes(root, errors);
  async function checkTemporary(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (isHiddenArchiveEntry(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.name.includes(".tmp-") || entry.name.includes(".stage-") || entry.name === "sync.lock") errors.push(`${relative(root, path)}: temporary file remains`);
      if (entry.isDirectory()) await checkTemporary(path);
    }
  }
  await checkTemporary(root);
  return { ok: errors.length === 0, documents: scan.documents.length, ids: ids.size, errors, warnings };
}
