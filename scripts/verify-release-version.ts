const packageManifest = JSON.parse(await Bun.file("package.json").text()) as {
	version?: unknown;
};

const version = packageManifest.version;
const separator = typeof version === "string" ? version.indexOf("-") : -1;
const core = typeof version === "string" ? (separator < 0 ? version : version.slice(0, separator)) : undefined;
const prerelease = typeof version === "string" && separator >= 0 ? version.slice(separator + 1) : undefined;
const parts = core?.split(".") ?? [];
const numericCore = parts.length === 3 && parts.every((part) => Boolean(part) && [...part].every((character) => character >= "0" && character <= "9"));
const validPrerelease = prerelease === undefined || (Boolean(prerelease) && [...prerelease].every((character) => (character >= "0" && character <= "9") || (character >= "A" && character <= "Z") || (character >= "a" && character <= "z") || character === "." || character === "-"));
if (!numericCore || !validPrerelease)
	throw new Error("package.json must contain a semver version");

const versionSource = await Bun.file("src/version.ts").text();
const expected = `export const MANAS_VERSION = "${version}";`;
if (!versionSource.includes(expected))
	throw new Error("canonical version module does not match package.json");

for (const path of ["src/cli.ts", "src/mcp/server.ts", "src/mcp/http.ts"]) {
	const source = await Bun.file(path).text();
	if (!source.includes('from "@manas-version"'))
		throw new Error(`${path} must use the canonical version module`);
}
