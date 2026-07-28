import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["src", "tests", "docs", "README.md", "package.json", "tsconfig.json"];
const secretPatterns: Array<[string, RegExp]> = [
	["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
	["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
	["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
	["OpenAI-style token", /\b(?:sk|rk)-(?:live|proj)-[A-Za-z0-9_-]{20,}\b/],
];
const findings: string[] = [];

async function scan(path: string): Promise<void> {
	const content = await readFile(path, "utf8");
	for (const [name, pattern] of secretPatterns) if (pattern.test(content)) findings.push(`${path}: ${name}`);
}

async function walk(path: string): Promise<void> {
	const entries = await readdir(path, { withFileTypes: true });
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) await walk(child);
		else if (entry.isFile() && /\.(?:ts|tsx|js|json|md|txt|yaml|yml|toml)$/.test(entry.name)) await scan(child);
	}
}

for (const root of roots) {
	try {
		const metadata = await Bun.file(root).stat();
		if (metadata.isFile()) await scan(root);
		else await walk(root);
	} catch {
		// Optional documentation roots may be absent in a packaged install.
	}
}

if (findings.length) {
	console.error(findings.join("\n"));
	process.exit(1);
}
console.log("secret/private-fixture scan passed");
