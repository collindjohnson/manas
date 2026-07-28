import { readdir } from "node:fs/promises";
import { join } from "node:path";

const roots = ["src", "tests"];
const failures: string[] = [];

async function walk(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (path.endsWith(".ts")) {
      const text = await Bun.file(path).text();
      if (text.includes("\r")) failures.push(`${path}: CRLF line endings`);
      if (/[ \t]+\n/.test(text)) failures.push(`${path}: trailing whitespace`);
    }
  }
}

for (const root of roots) await walk(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("format check passed");
