import { runAgentHook } from "../src/agent-hook-runtime";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { callLocalService, localServicePaths, localServiceRegistry, startLocalService } from "../src/local-service";
import { openPgliteBrainStore } from "../src/brain/store";
import { StoreOwnedError } from "../src/brain/ownership";

test("authenticated service owns PGLite and serves concurrent catalog clients", async () => {
	const root = await mkdtemp(join(tmpdir(), "manas-service-"));
	const config = { ...defaultConfig({}), stateRoot: join(root, "state") };
	try {
		await expect(callLocalService(config, "service.status", {}, { timeoutMs: 200 })).rejects.toMatchObject({ code: "service_unavailable" });
		const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), worker: false });
		try {
			expect((await stat(localServicePaths(config).token)).mode & 0o777).toBe(0o600);
			expect((await stat(localServicePaths(config).socket)).mode & 0o777).toBe(0o600);
			await expect(openPgliteBrainStore(join(root, "store"))).rejects.toBeInstanceOf(StoreOwnedError);
			await expect(startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "other"), worker: false })).rejects.toBeInstanceOf(StoreOwnedError);
			await expect(callLocalService(config, "service.status", {}, { token: "wrong" })).rejects.toMatchObject({ code: "unauthorized" });
			await expect(callLocalService(config, "service.status", {}, { repositoryRoot: join(root, "other-brain") })).rejects.toMatchObject({ code: "brain_mismatch" });
			const registry = await localServiceRegistry(config, join(root, "brain"));
			const results = await Promise.all(Array.from({ length: 8 }, () => registry.execute({ scope: "read" }, "skills.list", {})));
			expect(results).toHaveLength(8);
			expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
			await expect(registry.execute({ scope: "read" }, "jobs.enqueue", { type: "reports", payload: {} })).rejects.toThrow("scope is insufficient");
			const job = await callLocalService(config, "jobs.enqueue", { type: "reports", payload: {}, idempotencyKey: "test" }) as { id: string };
			expect(await callLocalService(config, "jobs.list")).toMatchObject([{ id: job.id, status: "pending" }]);
		} finally { await service.close(); }
		const restarted = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), worker: false });
		try {
			expect(await callLocalService(config, "jobs.list")).toMatchObject([{ status: "pending" }]);
			expect(await callLocalService(config, "service.stop")).toEqual({ stopping: true });
			await new Promise((done) => setTimeout(done, 30));
			await expect(callLocalService(config, "service.status")).rejects.toMatchObject({ code: "service_unavailable" });
		} finally { await restarted.close(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("service rejects operational state inside the Git brain and preserves occupied paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "manas-service-boundary-"));
	const config = { ...defaultConfig({}), stateRoot: join(root, "state") };
	try {
		await expect(startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "brain", "state") })).rejects.toThrow("outside");
		await Bun.write(localServicePaths(config).socket, "unrelated file");
		await expect(startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store") })).rejects.toThrow("occupied");
		expect(await Bun.file(localServicePaths(config).socket).text()).toBe("unrelated file");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI and stdio MCP share the running service and its worker", async () => {
	const root = await mkdtemp(join(tmpdir(), "manas-service-clients-"));
	const config = { ...defaultConfig({}), stateRoot: join(root, "state") };
	const configPath = join(root, "config.json");
	const failures: unknown[] = [];
	try {
		await writeFile(configPath, JSON.stringify(config));
		const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), onWorkerError: (error) => failures.push(error) });
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const run = promisify(execFile);
			await run("git", ["-C", service.engine.repository.root, "config", "user.name", "Test"]);
			await run("git", ["-C", service.engine.repository.root, "config", "user.email", "test@example.invalid"]);
			await service.engine.repository.putPage("notes/context.md", "Juniper ownership belongs to Maya.");
			await callLocalService(config, "jobs.enqueue", { type: "indexing", payload: { repositoryRoot: service.engine.repository.root }, idempotencyKey: "project" });
			let jobs: Array<{ status: string }> = [];
			for (let attempt = 0; attempt < 100; attempt++) {
				jobs = await callLocalService(config, "jobs.list") as typeof jobs;
				if (jobs[0]?.status === "complete" || jobs[0]?.status === "failed") break;
				await new Promise((done) => setTimeout(done, 30));
			}
			expect(jobs[0]?.status).toBe("complete");
			expect(failures).toEqual([]);
            const head = await service.engine.repository.head();
            const written = await run(process.execPath, ["src/cli.ts", "--config", configPath, "brain", "put", "--repo", service.engine.repository.root, "--store", join(root, "store"), "--path", "notes/new-context.md", "--content", "Zephyr launch is scheduled for Friday.", "--expected-head", head!]);
            expect(JSON.parse(written.stdout)).toMatchObject({ ok: true, data: { path: "notes/new-context.md" } });
            const fetched = await run(process.execPath, ["src/cli.ts", "--config", configPath, "brain", "get", "--repo", service.engine.repository.root, "--store", join(root, "store"), "--path", "notes/new-context.md"]);
            expect(JSON.parse(fetched.stdout)).toMatchObject({ ok: true, data: { content: "Zephyr launch is scheduled for Friday." } });
            expect(await callLocalService(config, "retrieval.search", { query: "Zephyr", options: { mode: "keyword" } })).toMatchObject({ results: [{ verifiedText: "Zephyr launch is scheduled for Friday." }] });
            const searched = await run(process.execPath, ["src/cli.ts", "--config", configPath, "brain", "search", "--repo", service.engine.repository.root, "--store", join(root, "store"), "--query", "Zephyr"]);
            expect(JSON.parse(searched.stdout)).toMatchObject({ ok: true, data: { results: [{ verifiedText: "Zephyr launch is scheduled for Friday." }] } });
            const indexed = await run(process.execPath, ["src/cli.ts", "--config", configPath, "brain", "index", "--repo", service.engine.repository.root, "--store", join(root, "store")]);
            expect(JSON.parse(indexed.stdout)).toMatchObject({ ok: true, data: { indexed: 0 } });
			const manualWorker = await run(process.execPath, ["src/cli.ts", "--config", configPath, "jobs", "run-one", "--repo", service.engine.repository.root, "--store", join(root, "store")]);
			expect(JSON.parse(manualWorker.stdout)).toMatchObject({ ok: true });

            const sourceRoot = join(root, "source");
            await mkdir(sourceRoot);
            await writeFile(join(sourceRoot, "shared.md"), "Orchid source evidence is current.");
            const synced = await run(process.execPath, ["src/cli.ts", "--config", configPath, "brain", "sources-sync", "--repo", service.engine.repository.root, "--source-path", sourceRoot]);
            expect(JSON.parse(synced.stdout)).toMatchObject({ ok: true, data: { created: 1 } });
            const captured = await run(process.execPath, ["src/cli.ts", "--config", configPath, "capture", "An authorized fixture note.", "--repo", service.engine.repository.root]);
            expect(JSON.parse(captured.stdout)).toMatchObject({ ok: true, data: { created: true } });
            const mail = join(root, "fixture.eml");
            await writeFile(mail, "Message-ID: service-fixture\nSubject: imported\n\nMarigold imported evidence.");
            const imported = await run(process.execPath, ["src/cli.ts", "--config", configPath, "brain", "import", "--repo", service.engine.repository.root, "--file", mail, "--format", "eml"]);
            expect(JSON.parse(imported.stdout)).toMatchObject({ ok: true, data: { created: 1, imported: 1 } });
            expect(await callLocalService(config, "retrieval.search", { query: "Marigold", options: { mode: "keyword" } })).toMatchObject({ results: [{ verifiedText: expect.stringContaining("Marigold imported evidence.") }] });
			const hook = await runAgentHook(config, "codex", { hook_event_name: "UserPromptSubmit", prompt: "Juniper", session_id: "fixture-session", turn_id: "fixture-turn" });
			expect(hook).toMatchObject({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: expect.stringContaining("Juniper ownership belongs to Maya.") } });
			const cli = await run(process.execPath, ["src/cli.ts", "--config", configPath, "operation", "retrieval.search", "--repo", service.engine.repository.root, "--input", JSON.stringify({ query: "Juniper" })]);
			expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, data: { results: [{ verifiedText: "Juniper ownership belongs to Maya." }] } });
			const child = Bun.spawn([process.execPath, "src/cli.ts", "--config", configPath, "serve"], { env: { ...process.env, MANAS_BRAIN_REPOSITORY: service.engine.repository.root }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "retrieval.search", arguments: { query: "Juniper" } } }) + "\n");
			child.stdin.end();
			const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
			expect(errors).toBe("");
			expect(code).toBe(0);
			const response = JSON.parse(output);
			expect(response.id).toBe(12);
			expect(JSON.parse(response.result.content[0].text)).toEqual(JSON.parse(cli.stdout).data);
			const scoped = Bun.spawn([process.execPath, "src/cli.ts", "--config", configPath, "serve", "--scope", "read"], { env: { ...process.env, MANAS_BRAIN_REPOSITORY: service.engine.repository.root }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
			for (const request of [
				{ jsonrpc: "2.0", id: 1, method: "tools/list" },
				{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query: "Juniper" } } },
				{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "retrieval.search", arguments: { query: "Juniper" } } },
			]) scoped.stdin.write(JSON.stringify(request) + "\n");
			scoped.stdin.end();
			const [scopedCode, scopedOutput] = await Promise.all([scoped.exited, new Response(scoped.stdout).text()]);
			expect(scopedCode).toBe(0);
			const scopedResponses = scopedOutput.trim().split("\n").map((line) => JSON.parse(line));
			const listing = scopedResponses.find((item) => item.id === 1).result.tools as Array<{ name: string }>;
			expect(listing.some((tool) => tool.name === "memory.remember" || tool.name === "jobs.enqueue" || tool.name === "search")).toBe(false);
			expect(scopedResponses.find((item) => item.id === 2).error.message).toContain("not available");
			expect(JSON.parse(scopedResponses.find((item) => item.id === 3).result.content[0].text).results[0].verifiedText).toContain("Juniper");

		} finally { await service.close(); }
	} finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);

test("local service propagates client deadline cancellation to long owner operations", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-service-cancel-"));
 const config = { ...defaultConfig({}), stateRoot: join(root, "state") };
 const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), worker: false });
 try {
  let observed!: () => void;
  const cancelled = new Promise<void>((resolve) => { observed = resolve; });
  let release!: () => void;
  service.engine.operations.register({ name: "test.owner-wait", description: "Test cancellation", inputSchema: { type: "object" }, outputSchema: { type: "object" }, requiredScope: "admin", trustBoundary: "local-only", execute: async (context) => {
   expect(context.signal).toBeDefined();
   await new Promise<void>((resolve) => { release = resolve; context.signal!.addEventListener("abort", () => { observed(); resolve(); }, { once: true }); });
   return { cancelled: true };
  } });
  await expect(callLocalService(config, "test.owner-wait", {}, { timeoutMs: 100 })).rejects.toMatchObject({ code: "service_timeout" });
  const result = await Promise.race([cancelled.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000))]);
  release?.();
  expect(result).toBe(true);
 } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);

test("local service accepts canonical-sized input and rejects oversized requests before enqueue", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-service-body-"));
 const config = { ...defaultConfig({}), stateRoot: join(root, "state") };
 try {
  const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), worker: false });
  try {
   const content = "x".repeat(1100000);
   const created = await callLocalService(config, "jobs.enqueue", { type: "reports", payload: { content }, idempotencyKey: "large-request" }) as { id: string; payload: { content: string } };
   expect(created.payload.content.length).toBe(content.length);
   await expect(callLocalService(config, "jobs.enqueue", { type: "reports", payload: { content: "x".repeat(8388608) }, idempotencyKey: "oversized-request" })).rejects.toMatchObject({ code: "request_too_large", retryable: false });
   const { request } = await import("node:http");
   const token = (await readFile(localServicePaths(config).token, "utf8")).trim();
   const rawResponse = await new Promise<{ status: number; error: { code: string } }>((resolve, reject) => {
    const raw = request({ socketPath: localServicePaths(config).socket, path: "/operation", method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }, (response) => {
     const chunks: Buffer[] = [];
     response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
     response.on("end", () => resolve({ status: response.statusCode!, error: JSON.parse(Buffer.concat(chunks).toString("utf8")).error }));
     response.on("error", reject);
    });
    raw.setTimeout(2000, () => raw.destroy(new Error("oversized request failed to return promptly")));
    raw.on("error", reject);
    raw.end(JSON.stringify({ operation: "jobs.enqueue", input: { type: "reports", payload: { content: "x".repeat(8388608) } } }));
   });
   expect(rawResponse).toMatchObject({ status: 413, error: { code: "request_too_large" } });
   expect(await service.engine.store!.query("SELECT id FROM brain_jobs")).toEqual([{ id: created.id }]);
  } finally { await service.close(); }
 } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
