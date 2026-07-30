import * as schemaModule from "./schema";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { assertBrainIdentity, assertBrainManifestEntry, assertBrainSettings, type BrainIdentityMetadata, type CanonicalRemoteConfiguration } from "./metadata";

const execFile = promisify(execFileCallback);
const metadataDirectory = ".brain";
const manifestName = "manifest.jsonl";
const identityName = "identity.json";
const settingsName = "settings.json";
const schemaPacksDirectory = "schema-packs";
const leaseName = "mutation.lock";
const leaseDurationMs = 5 * 60 * 1000;
const slash = String.fromCharCode(47);

export const DEFAULT_BRAIN_DIRECTORIES = ["inbox", "notes", "people", "organizations", "meetings", "email", "conversations", "files"] as const;
export const REPOSITORY_FAULT_POINTS = [
	"page-temp-file-write",
	"page-rename",
	"manifest-temp-file-write",
	"manifest-replacement",
	"staging",
	"commit-creation",
	"post-commit-cleanup",
] as const;
export type RepositoryFaultPoint = (typeof REPOSITORY_FAULT_POINTS)[number];
export type RepositoryFaultInjector = (point: RepositoryFaultPoint) => void | Promise<void>;
export interface BrainRepositoryOptions {
	faultInjector?: RepositoryFaultInjector;
}

export interface BrainSourceRecord {
	type: string;
	externalId: string;
	provenance?: { sourceType: string; sourcePath?: string; retrievedAt: string; metadata?: Record<string, string> };
	externalRevision?: string;
	contentHash?: string;
	extractionMetadata?: Record<string, string>;
	updatedAt?: string;
	visibilityLabels?: string[];
	managedSections?: string[];
}

export interface BrainManifestEntry {
	id: string;
	path: string;
	contentHash: string;
	revision: string;
	source?: BrainSourceRecord;
	deleted?: boolean;
	deletedAt?: string;
	stale?: boolean;
	accessLabels?: string[];
}

export interface BrainPage extends BrainManifestEntry {
	content: string;
	deleted: boolean;
}

export interface MutationResult extends BrainPage {
	commit: string;
}

export interface BrainSnapshot extends BrainIdentityMetadata {
	commit: string;
	pages: BrainManifestEntry[];
	settings: BrainSettings;
}

export interface BrainSettings {
	schemaPack: { id: string; version: string };
	sources: Record<string, { type: string; version?: string; kind?: string; trusted?: boolean }>;
}

export type BrainMutation =
	| { type: "put"; path: string; content: string; expectedRevision?: string; source?: BrainSourceRecord; expectedHead?: string }
	| { type: "move"; from: string; to: string; expectedRevision: string; expectedHead?: string }
	| { type: "delete"; path: string; expectedRevision: string; expectedHead?: string }
	| { type: "restore"; id: string; path: string; expectedRevision: string; expectedHead?: string };

export interface RepositoryVerification {
	commit: string;
	valid: boolean;
	issues: string[];
}

export interface PageHistoryEntry {
	commit: string;
	message: string;
	createdAt: string;
}

export interface AuthoritativeBrainRepository {
	head(): Promise<string | undefined>;
	snapshot(ref?: string): Promise<BrainSnapshot>;
	readPage(snapshot: BrainSnapshot, id: string): Promise<BrainPage>;
	mutate(request: BrainMutation): Promise<MutationResult>;
	verify(ref?: string): Promise<RepositoryVerification>;
	getIdentity(): Promise<BrainIdentityMetadata>;
	setCanonicalRemote(remote: CanonicalRemoteConfiguration | null, expectedHead?: string): Promise<{ identity: BrainIdentityMetadata; commit: string }>;
	getSettings(): Promise<BrainSettings>;
	setSchemaPack(pack: { id: string; version: string }, expectedHead?: string): Promise<{ settings: BrainSettings; commit: string }>;
	listSchemaPacks(): Promise<Array<{ id: string; version: string; pathTypes: Record<string, string> }>>;
	installSchemaPack(pack: { id: string; version: string; pathTypes: Record<string, string> }, expectedHead?: string): Promise<{ pack: { id: string; version: string; pathTypes: Record<string, string> }; commit: string }>;
	registerSourceDescriptor(descriptor: { id: string; version: string; kind: string; trusted: boolean }, expectedHead?: string): Promise<{ settings: BrainSettings; commit: string }>;
	setPageAccessLabels(path: string, labels: string[], expectedRevision: string, expectedHead?: string): Promise<MutationResult>;
	purgeDeletedPage(id: string, expectedHead?: string, retentionDays?: number, now?: Date): Promise<{ id: string; commit: string }>;
}

function digest(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function manifestPath(root: string): string {
	return join(root, metadataDirectory, manifestName);
}

function identityPath(root: string): string {
	return join(root, metadataDirectory, identityName);
}

function settingsPath(root: string): string {
	return join(root, metadataDirectory, settingsName);
}

function schemaPackPath(root: string, id: string, version: string): string {
	return join(root, metadataDirectory, schemaPacksDirectory, `${id}@${version}.json`);
}

function schemaPackMetadataPath(id: string, version: string): string {
	return metadataPath(schemaPacksDirectory, `${id}@${version}.json`);
}

function leasePath(root: string): string {
	return join(root, metadataDirectory, leaseName);
}

function metadataPath(...parts: string[]): string {
	return join(metadataDirectory, ...parts);
}

function asPath(root: string, value: string, internal = false): string {
	if (!value || value.includes("\\") || value.startsWith(slash) || (!internal && (value === metadataDirectory || value.startsWith(`${metadataDirectory}${slash}`)))) throw new Error("invalid brain page path");
	const path = resolve(root, value);
	if (!path.startsWith(`${root}${sep}`)) throw new Error("brain page path escapes repository");
	return path;
}

function relativePath(root: string, path: string): string {
	return relative(root, path).split(sep).join(slash);
}

async function git(root: string, args: string[], trim = true): Promise<string> {
	const result = await execFile("git", ["-C", root, ...args], { maxBuffer: 1024 * 1024 });
	return trim ? result.stdout.trim() : result.stdout;
}

async function regularFile(path: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("brain pages must be regular files");
}

async function loadManifest(root: string): Promise<BrainManifestEntry[]> {
	try {
		return (await readFile(manifestPath(root), "utf8")).split("\n").filter(Boolean).map((line) => assertBrainManifestEntry(JSON.parse(line)) as BrainManifestEntry);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

type BrainIdentity = BrainIdentityMetadata;
const defaultSettings: BrainSettings = { schemaPack: { id: "default", version: "1" }, sources: {} };

async function writeAtomic(
	path: string,
	content: string,
	points: { tempFileWrite: RepositoryFaultPoint; replacement: RepositoryFaultPoint } | undefined,
	inject: RepositoryFaultInjector | undefined,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	if (points) await inject?.(points.tempFileWrite);
	await writeFile(temporary, content, { mode: 0o600 });
	if (points) await inject?.(points.replacement);
	await rename(temporary, path);
	await chmod(path, 0o600);
}

async function writeManifest(root: string, entries: BrainManifestEntry[], inject?: RepositoryFaultInjector): Promise<void> {
	const content = [...entries].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => JSON.stringify(entry)).join("\n");
	await writeAtomic(manifestPath(root), content ? `${content}\n` : "", { tempFileWrite: "manifest-temp-file-write", replacement: "manifest-replacement" }, inject);
}

export class BrainRepository implements AuthoritativeBrainRepository {
	private queue = Promise.resolve();
	constructor(readonly root: string, private readonly options: BrainRepositoryOptions = {}) {}

	private async inject(point: RepositoryFaultPoint): Promise<void> {
		await this.options.faultInjector?.(point);
	}

	private async serialized<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.queue;
		let release!: () => void;
		this.queue = new Promise((done) => { release = done; });
		await previous;
		try { return await action(); } finally { release(); }
	}

	private async withMutationLease<T>(action: () => Promise<T>): Promise<T> {
		const path = leasePath(this.root);
		const token = randomUUID();
		for (let attempt = 0; attempt < 120; attempt++) {
			try {
				const handle = await open(path, "wx", 0o600);
				try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, expiresAt: Date.now() + leaseDurationMs })); }
				finally { await handle.close(); }
				try { return await action(); }
				finally {
					try {
						const current = JSON.parse(await readFile(path, "utf8")) as { token?: string };
						if (current.token === token) await unlink(path);
					} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					const lease = JSON.parse(await readFile(path, "utf8")) as { expiresAt?: number };
					if (typeof lease.expiresAt === "number" && lease.expiresAt < Date.now()) { await unlink(path); continue; }
				} catch (readError) { if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue; }
				await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
			}
		}
		throw new Error("brain repository mutation lease is held by another process");
	}

	private mutating<T>(action: () => Promise<T>): Promise<T> {
		return this.serialized(() => this.withMutationLease(action));
	}

	async initialize(): Promise<void> {
		await this.serialized(async () => {
			await mkdir(this.root, { recursive: true, mode: 0o700 });
			await chmod(this.root, 0o700);
			try { await git(this.root, ["rev-parse", "--is-inside-work-tree"]); } catch { await git(this.root, ["init"]); }
			for (const directory of DEFAULT_BRAIN_DIRECTORIES) await mkdir(join(this.root, directory), { recursive: true, mode: 0o700 });
			await mkdir(join(this.root, metadataPath("trash")), { recursive: true, mode: 0o700 });
			await mkdir(join(this.root, metadataPath(schemaPacksDirectory)), { recursive: true, mode: 0o700 });
			try { await regularFile(identityPath(this.root)); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				const identity: BrainIdentityMetadata = {
					metadataVersion: 1,
					brainId: randomUUID(),
					repositoryId: randomUUID(),
					generatedContentOwner: "manas",
					managedSectionOwner: "source-adapters",
					tombstonePolicy: { mode: "recoverable-trash", retentionDays: 30, deletionTimestampField: "deletedAt" },
					canonicalRemote: null,
					protectedBranchPolicy: { branches: ["main", "master"], requireExpectedHead: true, allowForcePush: false, pushMode: "explicit" },
				};
				await writeAtomic(identityPath(this.root), `${JSON.stringify(identity)}\n`, undefined, undefined);
			}
			try { await regularFile(manifestPath(this.root)); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await writeManifest(this.root, [], this.options.faultInjector);
			}
			try { await regularFile(settingsPath(this.root)); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await writeAtomic(settingsPath(this.root), `${JSON.stringify(defaultSettings)}\n`, undefined, undefined);
			}
		});
	}

	async head(): Promise<string | undefined> {
		try { return await git(this.root, ["rev-parse", "--verify", "HEAD"]); }
		catch { return undefined; }
	}

	async snapshot(ref = "HEAD"): Promise<BrainSnapshot> {
		const commit = await git(this.root, ["rev-parse", ref]);
		const [identityText, manifestText, settingsText] = await Promise.all([
			git(this.root, ["show", `${commit}:${metadataPath(identityName)}`]),
			git(this.root, ["show", `${commit}:${metadataPath(manifestName)}`]),
			git(this.root, ["show", `${commit}:${metadataPath(settingsName)}`]),
		]);
		const identity = assertBrainIdentity(JSON.parse(identityText));
		const settings = assertBrainSettings(JSON.parse(settingsText)) as BrainSettings;
		return { ...identity, commit, pages: manifestText.split("\n").filter(Boolean).map((line) => assertBrainManifestEntry(JSON.parse(line)) as BrainManifestEntry), settings };
	}

	async readPage(snapshot: BrainSnapshot, id: string): Promise<BrainPage> {
		const entry = snapshot.pages.find((page) => page.id === id);
		if (!entry) throw new Error("brain page is not present in snapshot");
		const content = await git(this.root, ["show", `${snapshot.commit}:${entry.path}`], false);
		return { ...entry, content, deleted: Boolean(entry.deleted) };
	}

	async verify(ref = "HEAD"): Promise<RepositoryVerification> {
		const snapshot = await this.snapshot(ref);
		const issues: string[] = [];
		const paths = new Set<string>();
		for (const page of snapshot.pages) {
			if (paths.has(page.path)) issues.push(`duplicate manifest path: ${page.path}`);
			paths.add(page.path);
			try {
				const loaded = await this.readPage(snapshot, page.id);
				if (digest(loaded.content) !== page.contentHash) issues.push(`content hash mismatch: ${page.path}`);
			} catch { issues.push(`missing snapshot page: ${page.path}`); }
		}
		return { commit: snapshot.commit, valid: issues.length === 0, issues };
	}

	async getIdentity(): Promise<BrainIdentityMetadata> {
		return assertBrainIdentity(JSON.parse(await readFile(identityPath(this.root), "utf8")));
	}

	async setCanonicalRemote(remote: CanonicalRemoteConfiguration | null, expectedHead?: string): Promise<{ identity: BrainIdentityMetadata; commit: string }> {
		return this.mutating(async () => {
			await this.assertExpectedHead(expectedHead);
			const initialCommit = (await this.head()) === undefined;
			const paths = initialCommit ? [metadataPath(identityName), metadataPath(manifestName), metadataPath(settingsName)] : [metadataPath(identityName)];
			await this.assertNoOwnedConflicts(paths);
			const identity = await this.getIdentity();
			identity.canonicalRemote = remote;
			const validated = assertBrainIdentity(identity);
			await writeAtomic(identityPath(this.root), `${JSON.stringify(validated)}\n`, undefined, undefined);
			return { identity: validated, commit: await this.commit(paths, "brain: set canonical remote") };
		});
	}

	async getSettings(): Promise<BrainSettings> {
		return assertBrainSettings(JSON.parse(await readFile(settingsPath(this.root), "utf8"))) as BrainSettings;
	}

	async setSchemaPack(pack: { id: string; version: string }, expectedHead?: string): Promise<{ settings: BrainSettings; commit: string }> {
		if (!schemaModule.bundledSchemaPack(pack.id, pack.version) && !(await this.listSchemaPacks()).some((candidate) => candidate.id === pack.id && candidate.version === pack.version)) throw new Error("schema pack is not installed");
		return this.mutating(async () => {
			await this.assertExpectedHead(expectedHead);
			const initialCommit = (await this.head()) === undefined;
			const paths = initialCommit ? [metadataPath(identityName), metadataPath(manifestName), metadataPath(settingsName)] : [metadataPath(settingsName)];
			await this.assertNoOwnedConflicts(paths);
			const settings = await this.getSettings();
			settings.schemaPack = { id: pack.id, version: pack.version };
			await writeAtomic(settingsPath(this.root), `${JSON.stringify(settings)}\n`, undefined, undefined);
			return { settings, commit: await this.commit(paths, `brain: set schema pack ${pack.id}`) };
		});
	}

	async listSchemaPacks(): Promise<Array<{ id: string; version: string; pathTypes: Record<string, string> }>> {
		const packs = new Map<string, { id: string; version: string; pathTypes: Record<string, string> }>();
		for (const bundled of schemaModule.BUNDLED_SCHEMA_PACKS as Array<{ id: string; version: string; pathTypes: Record<string, string> }>) packs.set(`${bundled.id}@${bundled.version}`, schemaModule.assertSchemaPack(bundled));
		try {
			for (const entry of await readdir(join(this.root, metadataDirectory, schemaPacksDirectory))) {
				if (!entry.endsWith(".json")) continue;
				const pack = schemaModule.assertSchemaPack(JSON.parse(await readFile(join(this.root, metadataDirectory, schemaPacksDirectory, entry), "utf8")));
				if (entry !== `${pack.id}@${pack.version}.json`) throw new Error("invalid installed schema pack");
				packs.set(`${pack.id}@${pack.version}`, pack);
			}
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		return [...packs.values()].sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
	}

	async installSchemaPack(pack: { id: string; version: string; pathTypes: Record<string, string> }, expectedHead?: string): Promise<{ pack: { id: string; version: string; pathTypes: Record<string, string> }; commit: string }> {
		const normalized = schemaModule.assertSchemaPack(pack) as { id: string; version: string; pathTypes: Record<string, string> };
		if (schemaModule.bundledSchemaPack(normalized.id, normalized.version)) throw new Error("bundled schema packs cannot be replaced");
		return this.mutating(async () => {
			await this.assertExpectedHead(expectedHead);
			const metadata = schemaPackMetadataPath(normalized.id, normalized.version);
			const initialCommit = (await this.head()) === undefined;
			const paths = initialCommit ? [metadataPath(identityName), metadataPath(manifestName), metadataPath(settingsName), metadata] : [metadata];
			await this.assertNoOwnedConflicts(paths);
			const target = schemaPackPath(this.root, normalized.id, normalized.version);
			try {
				const existing = schemaModule.assertSchemaPack(JSON.parse(await readFile(target, "utf8")));
				if (JSON.stringify(existing) === JSON.stringify(normalized)) return { pack: normalized, commit: await git(this.root, ["rev-parse", "HEAD"]) };
				throw new Error("schema pack version already exists");
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			await writeAtomic(target, `${JSON.stringify(normalized)}\n`, undefined, undefined);
			return { pack: normalized, commit: await this.commit(paths, `brain: install schema pack ${normalized.id}`) };
		});
	}

	async registerSourceDescriptor(descriptor: { id: string; version: string; kind: string; trusted: boolean }, expectedHead?: string): Promise<{ settings: BrainSettings; commit: string }> {
		if (!descriptor.id.trim() || !descriptor.version.trim() || !descriptor.kind.trim()) throw new Error("invalid source descriptor");
		return this.mutating(async () => {
			await this.assertExpectedHead(expectedHead);
			const initialCommit = (await this.head()) === undefined;
			const paths = initialCommit ? [metadataPath(identityName), metadataPath(manifestName), metadataPath(settingsName)] : [metadataPath(settingsName)];
			await this.assertNoOwnedConflicts(paths);
			const settings = await this.getSettings();
			const value = { type: descriptor.id, version: descriptor.version, kind: descriptor.kind, trusted: descriptor.trusted };
			if (JSON.stringify(settings.sources[descriptor.id]) === JSON.stringify(value)) return { settings, commit: await git(this.root, ["rev-parse", "HEAD"]) };
			settings.sources[descriptor.id] = value;
			await writeAtomic(settingsPath(this.root), `${JSON.stringify(settings)}\n`, undefined, undefined);
			return { settings, commit: await this.commit(paths, `brain: register source ${descriptor.id}`) };
		});
	}

	async setPageAccessLabels(path: string, labels: string[], expectedRevision: string, expectedHead?: string): Promise<MutationResult> {
		if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string" || !label.trim() || label.length > 128)) throw new Error("invalid access labels");
		const normalizedLabels = [...new Set(labels.map((label) => label.trim()))].sort();
		return this.mutating(async () => {
			await this.assertExpectedHead(expectedHead);
			const normalized = relativePath(this.root, asPath(this.root, path));
			await this.assertNoOwnedConflicts([metadataPath(manifestName)]);
			const entries = await loadManifest(this.root);
			const entry = entries.find((item) => item.path === normalized && !item.deleted);
			if (!entry || entry.revision !== expectedRevision) throw new Error("stale brain page revision");
			entry.accessLabels = normalizedLabels;
			await writeManifest(this.root, entries, this.options.faultInjector);
			const commit = await this.commit([metadataPath(manifestName)], `brain: set access labels ${normalized}`);
			return { ...entry, content: await readFile(asPath(this.root, normalized), "utf8"), deleted: false, commit };
		});
	}

	async pageHistory(path: string, limit = 50): Promise<PageHistoryEntry[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid brain history limit");
		const normalized = relativePath(this.root, asPath(this.root, path));
		const output = await git(this.root, ["log", `-n${limit}`, "--format=%H%x1f%aI%x1f%s", "--", normalized]);
		if (!output) return [];
		return output.split("\n").map((line) => {
			const [commit, createdAt, message] = line.split("\u001f");
			return { commit: commit!, createdAt: createdAt!, message: message! };
		});
	}

	async revertPage(path: string, ref: string, expectedRevision: string, expectedHead?: string): Promise<MutationResult> {
		const normalized = relativePath(this.root, asPath(this.root, path));
		const content = await git(this.root, ["show", `${ref}:${normalized}`], false);
		return this.putPage(normalized, content, expectedRevision, undefined, expectedHead);
	}

	async mutate(request: BrainMutation): Promise<MutationResult> {
		switch (request.type) {
			case "put": return this.putPage(request.path, request.content, request.expectedRevision, request.source, request.expectedHead);
			case "move": return this.movePage(request.from, request.to, request.expectedRevision, request.expectedHead);
			case "delete": return this.deletePage(request.path, request.expectedRevision, request.expectedHead);
			case "restore": return this.restorePage(request.id, request.path, request.expectedRevision, request.expectedHead);
		}
	}

	private async assertExpectedHead(expectedHead?: string): Promise<void> {
		if (expectedHead === undefined) return;
		const actual = await git(this.root, ["rev-parse", "HEAD"]);
		if (actual !== expectedHead) throw new Error("stale brain repository head");
	}

	private async assertNoOwnedConflicts(paths: string[]): Promise<void> {
		const status = await git(this.root, ["status", "--porcelain", "--", ...paths]);
		if (!status) return;
		try {
			await git(this.root, ["rev-parse", "--verify", "HEAD"]);
		} catch {
			const allowed = new Set([metadataPath(identityName), metadataPath(manifestName), metadataPath(settingsName)]);
			const changed = status.split("\n").filter(Boolean).map((line) => line.slice(3));
			if (changed.every((path) => allowed.has(path))) return;
		}
		throw new Error("brain repository has uncommitted changes in operation-owned paths");
	}

	private async rollbackUncommittedMutation(
		previousHead: string | undefined,
		paths: string[],
		restore: () => Promise<void>,
	): Promise<void> {
		if (await this.head() !== previousHead) return;
		await restore();
		try {
			await git(this.root, ["reset", "--quiet", "--", ...paths]);
		} catch {
			// A repository without a commit has no index to reset. Restored
			// working-tree bytes are still the authoritative recovery state.
		}
	}

	async getPage(path: string, includeDeleted = false): Promise<BrainPage | undefined> {
		const normalized = relativePath(this.root, asPath(this.root, path));
		const entry = (await loadManifest(this.root)).find((item) => item.path === normalized && (includeDeleted || !item.deleted));
		if (!entry) return undefined;
		const file = asPath(this.root, entry.path);
		await regularFile(file);
		return { ...entry, content: await readFile(file, "utf8"), deleted: Boolean(entry.deleted) };
	}

	async listPages(includeDeleted = false): Promise<BrainManifestEntry[]> {
		return (await loadManifest(this.root)).filter((entry) => includeDeleted || !entry.deleted);
	}

	async reconcileManifest(expectedHead?: string): Promise<{ created: number; renamed: number; warnings: string[] }> {
		return this.mutating(async () => {
			await this.assertExpectedHead(expectedHead);
			const entries = await loadManifest(this.root);
			const files: Array<{ path: string; hash: string }> = [];
			const visit = async (directory: string): Promise<void> => {
				for (const item of await readdir(directory, { withFileTypes: true })) {
					if (item.name === metadataDirectory || item.name === ".git") continue;
					const path = join(directory, item.name);
					if (item.isSymbolicLink()) continue;
					if (item.isDirectory()) { await visit(path); continue; }
					if (!item.isFile() || !item.name.endsWith(".md")) continue;
					const content = await readFile(path, "utf8");
					files.push({ path: relativePath(this.root, path), hash: digest(content) });
				}
			};
			await visit(this.root);
			const active = entries.filter((entry) => !entry.deleted);
			const knownPaths = new Set(active.map((entry) => entry.path));
			const unseen = files.filter((file) => !knownPaths.has(file.path));
			const missing = active.filter((entry) => !files.some((file) => file.path === entry.path));
			const warnings: string[] = [];
			let created = 0;
			let renamed = 0;
			let changed = false;
			const ownedPaths = new Set<string>([metadataPath(manifestName)]);
			for (const file of unseen) {
				const matches = missing.filter((entry) => entry.contentHash === file.hash);
				if (matches.length === 1) {
					const previousPath = matches[0]!.path;
					matches[0]!.path = file.path;
					matches[0]!.revision = file.hash;
					renamed += 1;
					changed = true;
					ownedPaths.add(previousPath);
					ownedPaths.add(file.path);
					continue;
				}
				if (matches.length > 1) warnings.push(`ambiguous rename: ${file.path}`);
				entries.push({ id: randomUUID(), path: file.path, contentHash: file.hash, revision: file.hash });
				created += 1;
				changed = true;
				ownedPaths.add(file.path);
			}
			for (const entry of active) {
				const file = files.find((candidate) => candidate.path === entry.path);
				if (file && entry.contentHash !== file.hash) { entry.contentHash = file.hash; entry.revision = file.hash; changed = true; ownedPaths.add(file.path); }
			}
			if (changed) {
				await writeManifest(this.root, entries, this.options.faultInjector);
				await this.commit([...ownedPaths], "brain: reconcile manifest");
			}
			return { created, renamed, warnings };
		});
	}

	async markStaleBySource(type: string, externalId: string): Promise<number> {
		return this.mutating(async () => {
			const entries = await loadManifest(this.root);
			const selected = entries.filter((entry) => !entry.deleted && !entry.stale && entry.source?.type === type && entry.source.externalId === externalId);
			if (!selected.length) return 0;
			for (const entry of selected) entry.stale = true;
			await writeManifest(this.root, entries, this.options.faultInjector);
			await this.commit([metadataPath(manifestName)], `brain: mark stale ${type}`);
			return selected.length;
		});
	}

	async putPage(path: string, content: string, expectedRevision?: string, source?: BrainSourceRecord | string, expectedHead?: string): Promise<MutationResult> {
		return this.mutating(async () => {
			// Before source metadata was added, the fourth positional argument was
			// the expected Git head. Keep that call shape working for callers that
			// still use it while treating actual source records normally.
			const legacyExpectedHead = typeof source === "string" ? source : expectedHead;
			const sourceRecord = typeof source === "string" ? undefined : source;
			await this.assertExpectedHead(legacyExpectedHead);
			const normalized = relativePath(this.root, asPath(this.root, path));
			await this.assertNoOwnedConflicts([normalized, metadataPath(manifestName), metadataPath(identityName), metadataPath(settingsName)]);
			const entries = await loadManifest(this.root);
			const existing = entries.find((entry) => entry.path === normalized && !entry.deleted);
			if ((existing && existing.revision !== expectedRevision) || (!existing && expectedRevision !== undefined)) throw new Error("stale brain page revision");
			const previousHead = await this.head();
			const pageFile = asPath(this.root, normalized);
			const originalPage = await readFile(pageFile, "utf8").catch((error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			});
			const originalManifest = await readFile(manifestPath(this.root), "utf8");
			const hash = digest(content);
			const entry: BrainManifestEntry = { id: existing?.id ?? randomUUID(), path: normalized, contentHash: hash, revision: hash, source: sourceRecord ?? existing?.source, stale: false, accessLabels: sourceRecord?.visibilityLabels ?? existing?.accessLabels };
			try {
				await writeAtomic(pageFile, content, { tempFileWrite: "page-temp-file-write", replacement: "page-rename" }, this.options.faultInjector);
				await writeManifest(this.root, [...entries.filter((item) => item.path !== normalized), entry], this.options.faultInjector);
				const commit = await this.commit([normalized, metadataPath(manifestName), metadataPath(identityName), metadataPath(settingsName)], `brain: put ${normalized}`, sourceRecord ?? existing?.source);
				return { ...entry, content, deleted: false, commit };
			} catch (error) {
				await this.rollbackUncommittedMutation(previousHead, [normalized, metadataPath(manifestName), metadataPath(identityName), metadataPath(settingsName)], async () => {
					if (originalPage === undefined) await unlink(pageFile).catch((cleanupError) => {
						if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
					});
					else await writeFile(pageFile, originalPage, { mode: 0o600 });
					await writeFile(manifestPath(this.root), originalManifest, { mode: 0o600 });
				});
				throw error;
			}
		});
	}

	async movePage(from: string, to: string, expectedRevision: string, expectedHead?: string): Promise<MutationResult> {
		return this.mutating(async () => { await this.assertExpectedHead(expectedHead); return this.relocate(from, to, expectedRevision, false); });
	}

	async deletePage(path: string, expectedRevision: string, expectedHead?: string): Promise<MutationResult> {
		return this.mutating(async () => {
			await this.assertExpectedHead(expectedHead);
			const source = relativePath(this.root, asPath(this.root, path));
			const entries = await loadManifest(this.root);
			const entry = entries.find((item) => item.path === source && !item.deleted);
			if (!entry || entry.revision !== expectedRevision) throw new Error("stale brain page revision");
			const target = metadataPath("trash", entry.id, basename(source));
			return this.relocate(source, target, expectedRevision, true, entries);
		});
	}

	async restorePage(id: string, path: string, expectedRevision: string, expectedHead?: string): Promise<MutationResult> {
		return this.mutating(async () => {
			await this.assertExpectedHead(expectedHead);
			const entries = await loadManifest(this.root);
			const entry = entries.find((item) => item.id === id && item.deleted);
			if (!entry || entry.revision !== expectedRevision) throw new Error("stale brain page revision");
			return this.relocate(entry.path, path, expectedRevision, false, entries, true);
		});
	}

	async purgeDeletedPage(id: string, expectedHead?: string, retentionDays = 30, now = new Date()): Promise<{ id: string; commit: string }> {
		if (!id || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error("invalid purge retention");
		return this.mutating(async () => {
			await this.assertExpectedHead(expectedHead);
			const entries = await loadManifest(this.root);
			const entry = entries.find((item) => item.id === id && item.deleted);
			if (!entry?.deletedAt || Number.isNaN(Date.parse(entry.deletedAt)) || now.getTime() - Date.parse(entry.deletedAt) < retentionDays * 24 * 60 * 60 * 1000) throw new Error("brain page retention period has not elapsed");
			await this.assertNoOwnedConflicts([entry.path, metadataPath(manifestName)]);
			const target = asPath(this.root, entry.path, true);
			await regularFile(target);
			await unlink(target);
			await writeManifest(this.root, entries.filter((item) => item.id !== id), this.options.faultInjector);
			return { id, commit: await this.commit([entry.path, metadataPath(manifestName)], `brain: purge ${id}`) };
		});
	}

	private async relocate(from: string, to: string, expectedRevision: string, deleted: boolean, entries?: BrainManifestEntry[], sourceInternal = false): Promise<MutationResult> {
		const manifest = entries ?? (await loadManifest(this.root));
		const source = relativePath(this.root, asPath(this.root, from, sourceInternal));
		const target = relativePath(this.root, asPath(this.root, to, deleted));
		await this.assertNoOwnedConflicts([source, target, metadataPath(manifestName)]);
		const entry = manifest.find((item) => item.path === source);
		if (!entry || entry.revision !== expectedRevision) throw new Error("stale brain page revision");
		if (manifest.some((item) => item.path === target && !item.deleted)) throw new Error("brain page target already exists");
		const sourceFile = asPath(this.root, source, true);
		await regularFile(sourceFile);
		const content = await readFile(sourceFile, "utf8");
		const targetFile = asPath(this.root, target, true);
		await mkdir(dirname(targetFile), { recursive: true, mode: 0o700 });
		await rename(sourceFile, targetFile);
		entry.path = target;
		entry.deleted = deleted;
		entry.deletedAt = deleted ? new Date().toISOString() : undefined;
		await writeManifest(this.root, manifest, this.options.faultInjector);
		const commit = await this.commit([source, target, metadataPath(manifestName)], `brain: ${deleted ? "delete" : "move"} ${source}`);
		return { ...entry, content, deleted, commit };
	}

	private async commit(paths: string[], message: string, source?: BrainSourceRecord): Promise<string> {
		await this.inject("staging");
		await git(this.root, ["add", "--", ...paths]);
		const operation = message.startsWith("brain: ") ? message.slice("brain: ".length).split(" ", 1)[0] : "mutation";
		const sourceLines = source
			? [
					`Brain-Source-Type: ${source.type}`,
					`Brain-Source-ID: ${source.externalId}`,
					...(source.externalRevision ? [`Brain-Source-Revision: ${source.externalRevision}`] : []),
				].join("\n")
			: "Brain-Source-Type: local";
		const body = `${message}\n\nBrain-Actor: manas\nBrain-Operation: ${operation}\nBrain-Correlation-ID: ${randomUUID()}\n${sourceLines}`;
		await this.inject("commit-creation");
		try { await git(this.root, ["commit", "--only", "-m", body, "--", ...paths]); }
		catch (error) { const detail = error as { stderr?: string }; throw new Error(detail.stderr?.includes("identity") ? "Git user identity is required to commit brain changes" : "unable to commit brain change"); }
		await this.inject("post-commit-cleanup");
		return git(this.root, ["rev-parse", "HEAD"]);
	}
}
