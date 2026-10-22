import { join } from "node:path";
import { readFile } from "node:fs/promises";

const names = ["manas-recall", "manas-capture", "manas-correct", "manas-answer", "manas-maintain"];
for (const name of names) {
 const path = join(import.meta.dir, "..", "skills", name, "SKILL.md");
 const text = await readFile(path, "utf8");
 const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
 if (!match) throw new Error(name + ": missing YAML frontmatter");
 const metadata = Bun.YAML.parse(match[1]!) as Record<string, unknown>;
 if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error(name + ": invalid frontmatter");
 if (metadata.name !== name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error(name + ": invalid skill identity");
 if (typeof metadata.description !== "string" || !metadata.description.trim() || metadata.description.length > 1024 || /[<>]/.test(metadata.description)) throw new Error(name + ": invalid description");
 if (Object.keys(metadata).some((key) => !["name", "description", "license", "allowed-tools", "metadata"].includes(key))) throw new Error(name + ": unsupported metadata");
 if (!match[2]!.trim() || /^\s*\[TODO:/m.test(match[2]!)) throw new Error(name + ": unfinished instructions");
}
console.log("Validated " + names.length + " Manas agent skills.");
