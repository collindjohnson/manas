import { access, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const PARITY_STATUS_VALUES = ["missing", "partial", "implemented", "verified"] as const;
export type ParityStatus = (typeof PARITY_STATUS_VALUES)[number];

export const REQUIRED_PARITY_CATEGORIES = [
	"advanced",
	"cli",
	"configuration",
	"hosted",
	"ingestion",
	"jobs",
	"library",
	"mcp",
	"migration",
	"models",
	"operations",
	"projection",
	"repository",
	"retrieval",
	"schema",
	"skills",
] as const;

export interface ParityCapability {
	id: string;
	category: string;
	status: ParityStatus;
	acceptance: string[];
	notes?: string;
}

export interface ParityManifest {
	$schema: string;
	product: string;
	target: {
		upstream: string;
		version: string;
		commit: string;
		pinnedAt: string;
	};
	statusValues: string[];
	releaseRule: string;
	architectureInvariants: string[];
	capabilities: ParityCapability[];
	categories: string[];
}

export interface ParityCapabilitySummary {
	id: string;
	category: string;
	status: ParityStatus;
	acceptance: string[];
	notes?: string;
}

export interface ParityReport {
	manifestPath: string;
	valid: true;
	capabilityCount: number;
	counts: Record<ParityStatus, number>;
	categories: string[];
	verified: string[];
	remaining: ParityCapabilitySummary[];
}

export class ParityManifestError extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(["parity manifest validation failed", ...issues.map((issue) => `- ${issue}`)].join("\n"));
		this.name = "ParityManifestError";
		this.issues = issues;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, field: string, issues: string[]): string | undefined {
	if (typeof value !== "string" || !value.trim()) {
		issues.push(`${field} must be a non-empty string`);
		return undefined;
	}
	return value;
}

function stringArray(value: unknown, field: string, issues: string[]): string[] | undefined {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		issues.push(`${field} must be an array of non-empty strings`);
		return undefined;
	}
	return value;
}

function isParityStatus(value: unknown): value is ParityStatus {
	return typeof value === "string" && (PARITY_STATUS_VALUES as readonly string[]).includes(value);
}

function relativePathWithinRoot(rootDir: string, candidate: string): string | undefined {
	if (isAbsolute(candidate)) return undefined;
	const root = resolve(rootDir);
	const absolute = resolve(root, candidate);
	const fromRoot = relative(root, absolute);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined;
	return absolute;
}

async function assertAcceptancePaths(
	capability: ParityCapability,
	rootDir: string,
	capabilityIndex: number,
	issues: string[],
): Promise<void> {
	for (const acceptancePath of capability.acceptance) {
		const absolute = relativePathWithinRoot(rootDir, acceptancePath);
		if (!absolute) {
			issues.push(`capabilities[${capabilityIndex}].acceptance path must be relative to the repository: ${acceptancePath}`);
			continue;
		}
		try {
			const details = await stat(absolute);
			if (!details.isFile()) issues.push(`acceptance-test path is not a file: ${acceptancePath}`);
		} catch {
			issues.push(`acceptance-test path does not exist: ${acceptancePath}`);
		}
	}
}

function emptyCounts(): Record<ParityStatus, number> {
	return { missing: 0, partial: 0, implemented: 0, verified: 0 };
}

function capabilitySummary(capability: ParityCapability): ParityCapabilitySummary {
	return {
		id: capability.id,
		category: capability.category,
		status: capability.status,
		acceptance: [...capability.acceptance],
		...(capability.notes === undefined ? {} : { notes: capability.notes }),
	};
}

export async function validateParityManifest(
	raw: unknown,
	options: { rootDir?: string; manifestPath?: string } = {},
): Promise<ParityReport> {
	const issues: string[] = [];
	const rootDir = options.rootDir ?? process.cwd();
	if (!isRecord(raw)) throw new ParityManifestError(["manifest root must be an object"]);

	const schema = stringValue(raw.$schema, "$schema", issues);
	if (schema && !schema.includes("json-schema.org")) issues.push("$schema must reference a JSON Schema vocabulary");
	stringValue(raw.product, "product", issues);
	const target = isRecord(raw.target) ? raw.target : undefined;
	if (!target) {
		issues.push("target must be an object");
	} else {
		stringValue(target.upstream, "target.upstream", issues);
		stringValue(target.version, "target.version", issues);
		stringValue(target.commit, "target.commit", issues);
		stringValue(target.pinnedAt, "target.pinnedAt", issues);
	}
	const declaredStatuses = stringArray(raw.statusValues, "statusValues", issues);
	if (declaredStatuses) {
		for (const status of declaredStatuses)
			if (!isParityStatus(status)) issues.push(`statusValues contains unknown status: ${status}`);
		for (const status of PARITY_STATUS_VALUES)
			if (!declaredStatuses.includes(status)) issues.push(`statusValues is missing required status: ${status}`);
	}
	stringValue(raw.releaseRule, "releaseRule", issues);
	stringArray(raw.architectureInvariants, "architectureInvariants", issues);

	const declaredCategories = stringArray(raw.categories, "categories", issues);
	if (declaredCategories) {
		const categorySet = new Set(declaredCategories);
		for (const category of REQUIRED_PARITY_CATEGORIES)
			if (!categorySet.has(category)) issues.push(`required category is absent: ${category}`);
	}

	const rawCapabilities = raw.capabilities;
	if (!Array.isArray(rawCapabilities)) {
		issues.push("capabilities must be an array");
		throw new ParityManifestError(issues);
	}

	const seenIds = new Set<string>();
	const capabilities: ParityCapability[] = [];
	for (const [index, value] of rawCapabilities.entries()) {
		if (!isRecord(value)) {
			issues.push(`capabilities[${index}] must be an object`);
			continue;
		}
		const id = stringValue(value.id, `capabilities[${index}].id`, issues);
		const category = stringValue(value.category, `capabilities[${index}].category`, issues);
		const status = value.status;
		if (!isParityStatus(status)) issues.push(`capabilities[${index}] has unknown status: ${String(status)}`);
		const acceptance = stringArray(value.acceptance, `capabilities[${index}].acceptance`, issues);
		if (value.notes !== undefined && typeof value.notes !== "string") issues.push(`capabilities[${index}].notes must be a string`);
		if (id && seenIds.has(id)) issues.push(`duplicate capability ID: ${id}`);
		if (id) seenIds.add(id);
		if (category && declaredCategories && !declaredCategories.includes(category)) issues.push(`capability category is not declared: ${category}`);
		if (status === "verified" && acceptance && acceptance.length === 0) issues.push(`verified capability lacks acceptance tests: ${id ?? `capabilities[${index}]`}`);
		if (!id || !category || !isParityStatus(status) || !acceptance) continue;
		const capability: ParityCapability = {
			id,
			category,
			status,
			acceptance,
			...(typeof value.notes === "string" ? { notes: value.notes } : {}),
		};
		capabilities.push(capability);
		await assertAcceptancePaths(capability, rootDir, index, issues);
	}

	if (issues.length) throw new ParityManifestError(issues);

	const counts = emptyCounts();
	for (const capability of capabilities) counts[capability.status] += 1;
	return {
		manifestPath: options.manifestPath ?? "docs/parity-manifest.json",
		valid: true,
		capabilityCount: capabilities.length,
		counts,
		categories: [...(declaredCategories ?? [])],
		verified: capabilities.filter((capability) => capability.status === "verified").map((capability) => capability.id),
		remaining: capabilities.filter((capability) => capability.status !== "verified").map(capabilitySummary),
	};
}

export async function verifyParityManifest(
	manifestPath = "docs/parity-manifest.json",
	options: { rootDir?: string; requireVerified?: boolean } = {},
): Promise<ParityReport> {
	const rootDir = options.rootDir ?? process.cwd();
	const absoluteManifestPath = resolve(rootDir, manifestPath);
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(absoluteManifestPath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : "unable to read manifest";
		throw new ParityManifestError([`unable to read or parse ${manifestPath}: ${message}`]);
	}
	const report = await validateParityManifest(raw, { rootDir, manifestPath });
	if (options.requireVerified && report.verified.length !== report.capabilityCount) {
		throw new ParityManifestError([`release gate requires every capability to be verified; remaining: ${report.remaining.map((capability) => capability.id).join(", ")}`]);
	}
	return report;
}

function parseCliArgs(args: string[]): { manifestPath: string; rootDir: string; reportPath?: string; requireVerified: boolean } {
	let manifestPath = "docs/parity-manifest.json";
	let rootDir = process.cwd();
	let reportPath: string | undefined;
	let requireVerified = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--manifest") manifestPath = args[++index] ?? "";
		else if (argument === "--root") rootDir = args[++index] ?? "";
		else if (argument === "--report") reportPath = args[++index];
		else if (argument === "--require-verified") requireVerified = true;
		else throw new Error(`unknown option: ${argument}`);
	}
	if (!manifestPath) throw new Error("--manifest requires a path");
	if (!rootDir) throw new Error("--root requires a path");
	return { manifestPath, rootDir: resolve(rootDir), reportPath, requireVerified };
}

async function main(): Promise<void> {
	try {
		const { manifestPath, rootDir, reportPath, requireVerified } = parseCliArgs(process.argv.slice(2));
		const report = await verifyParityManifest(manifestPath, { rootDir, requireVerified });
		const output = `${JSON.stringify(report, null, 2)}\n`;
		if (reportPath) {
			const absoluteReportPath = resolve(rootDir, reportPath);
			await access(rootDir);
			await writeFile(absoluteReportPath, output, { mode: 0o600 });
		}
		process.stdout.write(output);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
