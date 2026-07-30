const manifest = JSON.parse(await Bun.file(["package", ".json"].join("")).text()) as { version?: unknown };
if (typeof manifest.version !== "string" || !manifest.version.trim()) throw new Error("package manifest must contain a version");
const source = [
	`export const MANAS_VERSION = ${JSON.stringify(manifest.version)};`,
	"",
	"export function releaseTag(version = MANAS_VERSION): string {",
	"\treturn `v${version}`;",
	"}",
	"",
].join("\n");
await Bun.write(["src", "version.ts"].join(String.fromCharCode(47)), source);
