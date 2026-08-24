import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";
let defaultConfigPath = "";
let defaultConfigContent = "";

async function runCli(args: string[]) {
	const child = Bun.spawn([process.execPath, join("src", "cli.ts"), ...args], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOME: root,
			MANAS_CONFIG_FILE: undefined,
			MANAS_ZEROENTROPY_API_KEY: undefined,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr, output: JSON.parse(stdout) as { ok: boolean; data?: Record<string, unknown>; error?: { message: string } } };
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "manas-cli-routing-"));
	const archiveRoot = join(root, "archive");
	const stateRoot = join(root, "state");
	const configRoot = join(root, ".config", "manas");
	await Promise.all([mkdir(archiveRoot, { recursive: true }), mkdir(stateRoot, { recursive: true }), mkdir(configRoot, { recursive: true })]);
	const slash = String.fromCharCode(47);
	const endpoint = ["http:", "", "127.0.0.1:9", "v1", "embeddings"].join(slash);
	defaultConfigPath = join(configRoot, "config.json");
	defaultConfigContent = JSON.stringify({
		configVersion: 1,
		archiveRoot,
		stateRoot,
		launchAgentPath: join(root, "agent.plist"),
		providers: {
			embedding: {
				endpoint,
				model: "test-local",
				privacy: "local",
				provider: "openai-compatible",
				dimensions: 3,
			},
		},
	});
	await writeFile(defaultConfigPath, defaultConfigContent);
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("plain CLI configuration discovery", () => {
	test("index, health, and semantic-only search load the default local provider config", async () => {
		const indexed = await runCli(["index"]);
		expect(indexed.exitCode).toBe(0);
		expect(indexed.output.ok).toBe(true);

		const health = await runCli(["health"]);
		expect(health.exitCode).toBe(0);
		expect(health.output.data).toMatchObject({ credential: "local", semantic: "ready", archiveDocuments: 0, indexedDocuments: 0 });
		expect(health.stdout).not.toContain("ZeroEntropy credential");

		const searched = await runCli(["search", "paraphrased question", "--semantic-only"]);
		expect(searched.exitCode).toBe(2);
		expect(searched.output.ok).toBe(true);
		expect(searched.stdout).not.toContain("ZeroEntropy");
		expect(searched.output.data).toMatchObject({ requestedMode: "semantic", effectiveMode: "unavailable", degraded: true });
	});

	test("unknown command flags remain errors after global config extraction", async () => {
		const result = await runCli(["health", "--config", join(root, ".config", "manas", "config.json"), "--unknown"]);
		expect(result.exitCode).toBe(1);
		expect(result.output.error?.message).toContain("health does not accept arguments");
	});

	test("setup repair ignores a malformed automatically discovered config when an explicit recovery file is supplied", async () => {
		const recoveryPath = join(root, "repair.json");
		await writeFile(recoveryPath, defaultConfigContent);
		await writeFile(defaultConfigPath, "{malformed");
		try {
			const result = await runCli(["setup", "--repair", "--yes", "--config", recoveryPath]);
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).not.toContain("not valid JSON");
			expect(result.stdout).toContain("installed release binary");
		} finally {
			await writeFile(defaultConfigPath, defaultConfigContent);
		}
	});
});
