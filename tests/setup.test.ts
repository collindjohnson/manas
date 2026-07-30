import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const slash = String.fromCharCode(47);
const setupModule = await import(["..", "src", "setup"].join(slash));
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function totals(overrides: Record<string, number> = {}) {
	return {
		scanned: 3,
		created: 2,
		updated: 1,
		skipped: 0,
		redacted: 0,
		warnings: 0,
		failures: 0,
		...overrides,
	};
}

function dependencies() {
	const calls: string[] = [];
	return {
		calls,
		value: {
			discover: async () => ({
				conversations: [{ provider: "codex" as const }],
				results: [
					{
						provider: "codex" as const,
						scanned: 3,
						warnings: [],
						failures: [],
					},
				],
			}),
			runSync: async (_config: unknown, options?: { dryRun?: boolean }) => {
				calls.push(options?.dryRun ? "preview" : "sync");
				return {
					report: { totals: totals(), failures: [] },
					changes: [{}, {}, {}],
				};
			},
			installAgent: async () => {
				calls.push("install");
				return "agent.plist";
			},
			activateAgent: async () => {
				calls.push("activate");
			},
			confirm: async () => false,
		},
	};
}

describe("Manas setup", () => {
	test("allows scheduling only from an installed binary", () => {
		expect(() => setupModule.assertSchedulingRuntime(true, "manas")).not.toThrow();
		expect(() => setupModule.assertSchedulingRuntime(true, "cli.ts")).toThrow("installed release binary");
		expect(() => setupModule.assertSchedulingRuntime(false, "cli.ts")).not.toThrow();
	});

	test("reports non-macOS scheduling as unsupported without changing setup intent", () => {
		expect(setupModule.schedulerAvailability(true, "linux")).toEqual({
			requested: true,
			supported: false,
			warning: "automatic scheduling is supported only on macOS",
		});
		expect(setupModule.schedulerAvailability(true, "darwin")).toEqual({
			requested: true,
			supported: true,
		});
	});

	test("repair requires an existing configuration before it changes scheduler state", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-setup-"));
		roots.push(root);
		const injected = dependencies();
		await expect(setupModule.setupManas({ configPath: join(root, "missing.json"), repair: true, yes: true }, injected.value)).rejects.toThrow("existing Manas configuration");
		expect(injected.calls).toEqual([]);
	});

	test("repair restores the prior LaunchAgent when activation fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-setup-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		await Bun.write(configPath, JSON.stringify({ archiveRoot: join(root, "archive"), stateRoot: join(root, "state"), launchAgentPath: join(root, "agent.plist") }));
		const calls: string[] = [];
		const dependencySet = dependencies();
		const injected: any = dependencySet.value;
		injected.runtime = { entrypoint: "manas", platform: "darwin" };
		injected.snapshotAgent = async () => async () => { calls.push("restore"); };
		injected.installAgent = async () => { calls.push("install"); return join(root, "agent.plist"); };
		injected.activateAgent = async () => { calls.push("activate"); throw new Error("receipt timed out"); };
		await expect(setupModule.setupManas({ configPath, repair: true, yes: true }, injected)).rejects.toThrow("receipt timed out");
		expect(calls).toEqual(["install", "activate", "restore"]);
	});

	test("renders the stable setup JSON document with null unperformed sections", () => {
		const root = String.fromCharCode(47);
		const document = setupModule.setupJsonDocument({
			mode: "detect-only",
			configPath: root + "config.json",
			archiveRoot: root + "archive",
			stateRoot: root + "state",
			sources: [],
			scheduler: { requested: false, installed: false },
		});
		expect(document).toMatchObject({ schema: "manas.setup.v1", exitCode: 0, preview: null, sync: null, error: null });
	});

	test("uses a deterministic JSON error category for invalid setup input", async () => {
		const slash = String.fromCharCode(47);
		const child = Bun.spawn([process.execPath, "src" + slash + "cli.ts", "setup", "--state", "ignored", "--json"], {
			cwd: import.meta.dir + slash + "..",
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await child.exited).toBe(2);
		expect(await new Response(child.stdout).json()).toMatchObject({
			schema: "manas.setup.v1",
			version: "0.1.0",
			exitCode: 2,
			error: { code: "invalid_request" },
		});
	});

	test("rejects source-mode LaunchAgent installation", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-setup-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		await Bun.write(configPath, JSON.stringify({ archiveRoot: join(root, "archive"), stateRoot: join(root, "state"), launchAgentPath: join(root, "agent.plist") }));
		const child = Bun.spawn([process.execPath, "src" + slash + "cli.ts", "install-launch-agent", "--config", configPath], {
			cwd: import.meta.dir + slash + "..",
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await child.exited).toBe(1);
		expect(await new Response(child.stdout).json()).toMatchObject({
			ok: false,
			command: "install-launch-agent",
			error: { message: "scheduling requires an installed release binary; source execution supports --no-schedule only" },
		});
	});

	test("detect-only is read-only and reports the Manas-owned default archive", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-setup-"));
		roots.push(root);
		const configPath = join(root, "config", "config.json");
		const injected = dependencies();
		const result = await setupModule.setupManas(
			{ configPath, detectOnly: true },
			injected.value,
		);
		expect(result.mode).toBe("detect-only");
		expect(result.archiveRoot).toContain(join(".local", "share", "manas", "archive"));
		expect(result.sources).toMatchObject([
			{ provider: "codex", detected: true, scanned: 3, eligible: 1 },
		]);
		expect(await Bun.file(configPath).exists()).toBe(false);
		expect(injected.calls).toEqual([]);
	});

	test("preview does not write configuration, sync, or activate", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-setup-"));
		roots.push(root);
		const configPath = join(root, "config", "config.json");
		const archiveRoot = join(root, "archive");
		const injected = dependencies();
		const result = await setupModule.setupManas(
			{ configPath, archiveRoot, previewOnly: true },
			injected.value,
		);
		expect(result.mode).toBe("preview");
		expect(result.preview?.totals).toMatchObject({ created: 2, updated: 1 });
		expect(injected.calls).toEqual(["preview"]);
		expect(await Bun.file(configPath).exists()).toBe(false);
	});

	test("uses injected configuration and archive adapters for planned mutation", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-setup-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		const writes: Array<{ path: string; archiveRoot: string }> = [];
		const injected: any = dependencies().value;
		injected.filesystem = {
			exists: async () => false,
			readText: async () => "",
			remove: async () => undefined,
		};
		injected.configuration = {
			load: async () => { throw new Error("unexpected configuration load"); },
			write: async (path: string, value: { archiveRoot: string }) => { writes.push({ path, archiveRoot: value.archiveRoot }); },
		};
		injected.archive = {
			exists: async () => false,
			verify: async () => ({ ok: true, errors: [] }),
		};
		await setupModule.setupManas({ configPath, archiveRoot: join(root, "archive"), yes: true, noSchedule: true }, injected);
		expect(writes).toEqual([{ path: configPath, archiveRoot: join(root, "archive") }]);
	});

	test("reuses an existing custom archive unless a new archive is explicit", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-setup-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		const archiveRoot = join(root, "existing-archive");
		await Bun.write(
			configPath,
			JSON.stringify({
				archiveRoot,
				stateRoot: join(root, "state"),
				launchAgentPath: join(root, "agent.plist"),
			}),
		);
		const result = await setupModule.setupManas(
			{ configPath, detectOnly: true },
			dependencies().value,
		);
		expect(result.archiveRoot).toBe(archiveRoot);
	});

	test("rejects contradictory modes before it performs detection", async () => {
		const injected = dependencies();
		await expect(
			setupModule.setupManas(
				{ detectOnly: true, previewOnly: true },
				injected.value,
			),
		).rejects.toThrow("choose either detectOnly or previewOnly");
		expect(injected.calls).toEqual([]);
	});

	test("rejects empty explicit paths instead of resolving them to the working directory", async () => {
		const injected = dependencies();
		await expect(
			setupModule.setupManas({ archiveRoot: "", detectOnly: true }, injected.value),
		).rejects.toThrow("archiveRoot must not be empty");
		expect(injected.calls).toEqual([]);
	});

	test("agent-approved setup syncs to a custom archive without scheduling when requested", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-setup-"));
		roots.push(root);
		const injected = dependencies();
		const result = await setupModule.setupManas(
			{
				configPath: join(root, "config.json"),
				archiveRoot: join(root, "chats"),
				yes: true,
				noSchedule: true,
			},
			injected.value,
		);
		expect(result.mode).toBe("configured");
		expect(result.scheduler).toEqual({ requested: false, installed: false });
		expect(injected.calls).toEqual(["preview", "sync"]);
	});

	test("reports scheduler unsupported on non-macOS without attempting installation", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-setup-"));
		roots.push(root);
		const dependencySet = dependencies();
		const injected: any = dependencySet.value;
		injected.runtime = { entrypoint: "cli.ts", platform: "linux" };
		const result = await setupModule.setupManas({ configPath: join(root, "config.json"), archiveRoot: join(root, "archive"), yes: true }, injected);
		expect(result.mode).toBe("configured");
		expect(result.scheduler).toMatchObject({ requested: true, installed: false, status: "unsupported" });
		expect(dependencySet.calls).toEqual(["preview", "sync"]);
	});

	test("revalidates planned source targets before mutation", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-setup-"));
		roots.push(root);
		let discoveries = 0;
		let syncs = 0;
		const injected: any = dependencies().value;
		injected.discover = async () => ({
			conversations: discoveries++ === 0 ? [{ provider: "codex" as const }] : [{ provider: "cursor" as const }],
			results: [{ provider: "codex" as const, scanned: 1, warnings: [], failures: [] }],
		});
		injected.runSync = async (_config: unknown, options?: { dryRun?: boolean }) => {
			if (!options?.dryRun) syncs += 1;
			return { report: { totals: totals(), failures: [] }, changes: [] };
		};
		await expect(setupModule.setupManas({ configPath: join(root, "config.json"), archiveRoot: join(root, "archive"), yes: true, noSchedule: true }, injected)).rejects.toThrow("targets changed after preview");
		expect(syncs).toBe(0);
	});

	test("applies the revalidated conversation snapshot instead of rediscovering during sync", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-setup-"));
		roots.push(root);
		const snapshots: unknown[] = [];
		const injected: any = dependencies().value;
		injected.runSync = async (_config: unknown, options?: { dryRun?: boolean; conversations?: unknown[] }) => {
			snapshots.push(options?.conversations);
			return { report: { totals: totals(), failures: [] }, changes: [] };
		};
		await setupModule.setupManas({ configPath: join(root, "config.json"), archiveRoot: join(root, "archive"), yes: true, noSchedule: true }, injected);
		expect(snapshots).toHaveLength(2);
		expect(snapshots[0]).toEqual(snapshots[1]);
	});

	test("rolls back the candidate LaunchAgent when activation fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "manas-setup-"));
		roots.push(root);
		const calls: string[] = [];
		const injected: any = dependencies().value;
		injected.runtime = { entrypoint: "manas", platform: "darwin" };
		injected.snapshotAgent = async () => async () => { calls.push("restore"); };
		injected.installAgent = async () => { calls.push("install"); return join(root, "agent.plist"); };
		injected.activateAgent = async () => { calls.push("activate"); throw new Error("receipt timed out"); };
		const configPath = join(root, "config.json");
		const failure = await setupModule.setupManas({ configPath, archiveRoot: join(root, "archive"), yes: true }, injected).then(() => undefined, (error: unknown) => error as Error & { setupExitCode?: number; setupCode?: string; setupPartial?: { sync?: unknown } });
		expect(failure?.message).toContain("configuration rollback completed");
		expect(failure?.setupExitCode).toBe(6);
		expect(failure?.setupCode).toBe("scheduler_activation_failed");
		expect(failure?.setupPartial?.sync).toBeDefined();
		expect(calls).toEqual(["install", "activate", "restore"]);
		expect(await Bun.file(configPath).exists()).toBe(false);
	});
});
