import { describe, expect, test } from "bun:test";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BrainRepository } from "../src/brain/repository";
import { openPgliteBrainStore } from "../src/brain/store";
import { indexBrainRepository } from "../src/brain/pglite-indexer";

const execFile = promisify(execFileCallback);

async function runStdio(repositoryRoot: string, requests: unknown[]): Promise<Array<Record<string, unknown>>> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["src/cli.ts", "serve"], {
			cwd: process.cwd(),
			env: { ...process.env, MANAS_BRAIN_REPOSITORY: repositoryRoot },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code !== 0) { reject(new Error(`stdio MCP exited with ${code}: ${stderr}`)); return; }
			try { resolve(stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)); }
			catch (error) { reject(error); }
		});
		child.stdin.end(requests.map((request) => JSON.stringify(request)).join("\n").concat("\n"));
	});
}

describe("operation transport parity", () => {
	test("runs the complete Git-backed brain CRUD lifecycle through the CLI", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-cli-crud-"));
		const repositoryRoot = join(root, "brain");
		const cliEnv = { ...process.env, GIT_AUTHOR_NAME: "CLI CRUD", GIT_AUTHOR_EMAIL: "cli-crud@example.invalid", GIT_COMMITTER_NAME: "CLI CRUD", GIT_COMMITTER_EMAIL: "cli-crud@example.invalid" };
		const cli = async (...args: string[]): Promise<any> => JSON.parse((await execFile(process.execPath, ["src/cli.ts", ...args], { cwd: process.cwd(), env: cliEnv })).stdout).data;
		try {
			await cli("brain", "init", "--repo", repositoryRoot);
			await execFile("git", ["-C", repositoryRoot, "config", "user.name", "CLI CRUD"]);
			await execFile("git", ["-C", repositoryRoot, "config", "user.email", "cli-crud@example.invalid"]);
			const created = await cli("brain", "put", "--repo", repositoryRoot, "--path", "notes/crud.md", "--content", "first");
			const updated = await cli("brain", "put", "--repo", repositoryRoot, "--path", "notes/crud.md", "--content", "second", "--expected-revision", created.revision, "--expected-head", created.commit);
			const moved = await cli("brain", "move", "--repo", repositoryRoot, "--from", "notes/crud.md", "--to", "notes/moved.md", "--expected-revision", updated.revision, "--expected-head", updated.commit);
			const labeled = await cli("brain", "access", "--repo", repositoryRoot, "--path", "notes/moved.md", "--labels", "team,private", "--expected-revision", moved.revision, "--expected-head", moved.commit);
			const deleted = await cli("brain", "delete", "--repo", repositoryRoot, "--path", "notes/moved.md", "--expected-revision", labeled.revision, "--expected-head", labeled.commit);
			const listed = await cli("brain", "list", "--repo", repositoryRoot, "--include-deleted");
			expect(listed.pages).toMatchObject([{ id: created.id, deleted: true, deletedAt: expect.any(String) }]);
			const restored = await cli("brain", "restore", "--repo", repositoryRoot, "--id", deleted.id, "--path", "notes/restored.md", "--expected-revision", deleted.revision, "--expected-head", deleted.commit);
			expect(await cli("brain", "get", "--repo", repositoryRoot, "--path", "notes/restored.md")).toMatchObject({ content: "second", accessLabels: ["private", "team"] });
			expect((await cli("brain", "history", "--repo", repositoryRoot, "--path", "notes/restored.md")).history.length).toBeGreaterThan(0);
			expect((await cli("brain", "export", "--repo", repositoryRoot)).pages).toContainEqual(expect.objectContaining({ path: "notes/restored.md", content: "second" }));
			expect((await cli("brain", "verify", "--repo", repositoryRoot)).valid).toBe(true);
			expect(restored.id).toBe(created.id);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test("executes the generated catalog through the CLI subprocess", async () => {
		const root = await mkdtemp(join(tmpdir(), "catalog-cli-"));
		try {
			const repository = new BrainRepository(join(root, "brain"));
			await repository.initialize();
			const result = await execFile(process.execPath, ["src/cli.ts", "skills", "list", "--repo", repository.root], { cwd: process.cwd(), env: process.env });
			const output = JSON.parse(result.stdout) as { ok: boolean; command: string; data: unknown[] };
			expect(output).toMatchObject({ ok: true, command: "skills" });
			expect(output.data).toHaveLength(5);
			const direct = await execFile(process.execPath, ["src/cli.ts", "operation", "skills.list", "--input", "{}", "--repo", repository.root], { cwd: process.cwd(), env: process.env });
			expect(JSON.parse(direct.stdout)).toMatchObject({ ok: true, command: "operation", data: output.data });
			const anomaly = await execFile(process.execPath, ["src/cli.ts", "analysis", "anomaly", "--input", JSON.stringify({ records: [{ id: "metric", tenantId: "local", brainId: "brain", baseline: 1, observed: 4, threshold: 1 }] }), "--repo", repository.root], { cwd: process.cwd(), env: process.env });
			expect(JSON.parse(anomaly.stdout)).toMatchObject({ ok: true, command: "analysis", data: [{ id: "metric", severity: "critical" }] });
			const storePath = join(root, "jobs-store");
			const schedule = await execFile(process.execPath, ["src/cli.ts", "jobs", "schedule", "--store", storePath, "--tenant", "tenant-a", "--input", JSON.stringify({ type: "report", payload: { format: "json" }, intervalSeconds: 60 })], { cwd: process.cwd(), env: process.env });
			expect(JSON.parse(schedule.stdout)).toMatchObject({ ok: true, command: "jobs", data: { tenantId: "tenant-a", type: "report" } });
			const schedules = await execFile(process.execPath, ["src/cli.ts", "jobs", "schedules", "--store", storePath, "--tenant", "tenant-a", "--input", "{}"], { cwd: process.cwd(), env: process.env });
			expect(JSON.parse(schedules.stdout)).toMatchObject({ ok: true, command: "jobs", data: [{ tenantId: "tenant-a", type: "report" }] });
			const adminUser = await execFile(process.execPath, ["src/cli.ts", "admin", "user-create", "--repo", repository.root, "--store", storePath, "--input", JSON.stringify({ id: "cli-user" }), "--scope", "admin"], { cwd: process.cwd(), env: process.env });
			expect(JSON.parse(adminUser.stdout)).toMatchObject({ ok: true, command: "admin", data: { id: "cli-user" } });
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test("executes generated catalog operations through a clean stdio MCP subprocess", async () => {
		const root = await mkdtemp(join(tmpdir(), "catalog-stdio-"));
		try {
				const repository = new BrainRepository(join(root, "brain"));
				await repository.initialize();
				const responses = await runStdio(repository.root, [
					{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
					{ jsonrpc: "2.0", method: "notifications/initialized" },
					{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
					{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "skills.list", arguments: {} } },
					{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "analysis.anomaly", arguments: { records: [{ id: "metric", tenantId: "local", brainId: "brain", baseline: 1, observed: 4, threshold: 1 }] } } },
				]);
			expect(responses[0]).toMatchObject({ id: 1, result: { protocolVersion: "2024-11-05" } });
			const tools = (responses[1]!.result as { tools: Array<{ name: string }> }).tools;
			expect(tools.some((tool) => tool.name === "skills.list")).toBe(true);
			expect(responses[2]).toMatchObject({ id: 3, result: { content: [{ type: "text" }] } });
			expect(JSON.parse(((responses[2]!.result as { content: Array<{ text: string }> }).content[0]!).text)).toHaveLength(5);
			expect(JSON.parse(((responses[3]!.result as { content: Array<{ text: string }> }).content[0]!).text)).toMatchObject([{ id: "metric", severity: "critical" }]);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test("CLI projected search emits exact Git-verified citation text", async () => {
		const root = await mkdtemp(join(tmpdir(), "cli-citation-contract-"));
		const store = await openPgliteBrainStore(join(root, "projection"));
		try {
			const repository = new BrainRepository(join(root, "brain"));
			await repository.initialize();
			await execFile("git", ["-C", repository.root, "config", "user.name", "CLI Contract"]);
			await execFile("git", ["-C", repository.root, "config", "user.email", "cli-contract@example.invalid"]);
			await repository.putPage("notes/citation.md", "CLI citation verification contract.");
			await indexBrainRepository(store, repository);
		} finally { await store.close(); }
		try {
			const result = await execFile(process.execPath, ["src/cli.ts", "brain", "search", "--query", "citation", "--repo", join(root, "brain"), "--store", join(root, "projection")], { cwd: process.cwd(), env: process.env });
			const output = JSON.parse(result.stdout) as { data: { results: Array<{ verifiedText: string; citation: { commit: string } }> } };
			expect(output.data.results[0]).toMatchObject({ verifiedText: "CLI citation verification contract.", citation: { commit: expect.any(String) } });
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test("CLI retrieval exposes bounded graph traversal with stable citations", async () => {
		const root = await mkdtemp(join(tmpdir(), "cli-graph-retrieval-"));
		const storePath = join(root, "projection");
		try {
			const repository = new BrainRepository(join(root, "brain"));
			await repository.initialize();
			await execFile("git", ["-C", repository.root, "config", "user.name", "CLI Graph"]);
			await execFile("git", ["-C", repository.root, "config", "user.email", "cli-graph@example.invalid"]);
			await repository.putPage("notes/a.md", "# A\n\nSee [[notes/b.md]].");
			await repository.putPage("notes/b.md", "# B\n\nGraph target.");
			const store = await openPgliteBrainStore(storePath);
			try { await indexBrainRepository(store, repository); } finally { await store.close(); }
			const result = await execFile(process.execPath, ["src/cli.ts", "brain", "related", "--path", "notes/a.md", "--depth", "2", "--repo", repository.root, "--store", storePath], { cwd: process.cwd(), env: process.env });
			expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { pages: [{ path: "notes/b.md", depth: 1 }] } });
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test("CLI ingestion covers capture, generic import, extraction, and source sync", async () => {
		const root = await mkdtemp(join(tmpdir(), "cli-ingestion-contract-"));
		const repositoryRoot = join(root, "brain");
		const cliEnv = { ...process.env, MANAS_STATE: join(root, "state"), MANAS_DIAGNOSTICS: "1", GIT_AUTHOR_NAME: "CLI Ingestion", GIT_AUTHOR_EMAIL: "cli-ingestion@example.invalid", GIT_COMMITTER_NAME: "CLI Ingestion", GIT_COMMITTER_EMAIL: "cli-ingestion@example.invalid" };
		const cli = async (...args: string[]): Promise<any> => JSON.parse((await execFile(process.execPath, ["src/cli.ts", ...args], { cwd: process.cwd(), env: cliEnv })).stdout).data;
		try {
			await cli("brain", "init", "--repo", repositoryRoot);
			await execFile("git", ["-C", repositoryRoot, "config", "user.name", "CLI Ingestion"]);
			await execFile("git", ["-C", repositoryRoot, "config", "user.email", "cli-ingestion@example.invalid"]);
			const emlPath = join(root, "message.eml");
			await writeFile(emlPath, "From: sender@example.invalid\nSubject: parity\n\nImported body");
			expect(await cli("brain", "import", "--file", emlPath, "--format", "eml", "--repo", repositoryRoot)).toMatchObject({ created: 1, imported: 1 });
			expect(await cli("capture", "captured note", "--repo", repositoryRoot)).toMatchObject({ created: true });
			const textPath = join(root, "extract.txt");
			await writeFile(textPath, "Extracted body");
			expect(await cli("brain", "extract", "--file", textPath, "--repo", repositoryRoot)).toMatchObject({ metadata: { extractor: "plain-text" } });
			const sourceRoot = join(root, "source");
			await mkdir(sourceRoot);
			await writeFile(join(sourceRoot, "source.md"), "Source body");
			expect(await cli("brain", "sources-sync", "--source-path", sourceRoot, "--repo", repositoryRoot)).toMatchObject({ created: 1 });
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
