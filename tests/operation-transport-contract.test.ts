import { describe, expect, test } from "bun:test";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BrainRepository } from "../src/brain/repository";
import { createFullOperationRegistry } from "../src/brain/operation-catalog";
import { DurableControlPlane } from "../src/brain/control-plane";
import { openPgliteBrainStore } from "../src/brain/store";
import { callMcpHttp } from "../src/mcp/client";
import { handleMcpHttpRequest } from "../src/mcp/http";

const execFile = promisify(execFileCallback);

const fixtures: Array<{ name: string; input: Record<string, unknown> }> = [
	{ name: "skills.list", input: {} },
	{ name: "skills.resolve", input: { id: "brain-search", agent: "codex" } },
	{ name: "analysis.features", input: {} },
	{ name: "analysis.evaluate", input: {} },
	{ name: "analysis.code", input: { path: "src/example.ts", content: "function answer() { return answer(); }" } },
	{ name: "analysis.docs", input: { path: "docs/example.md", markdown: "The answer is documented.", code: { symbols: [{ id: "src/example.ts:answer:0", name: "answer", kind: "function", path: "src/example.ts", startOffset: 0, endOffset: 16 }], edges: [] } } },
	{ name: "analysis.brainstorm", input: { query: "parity", context: ["tests"] } },
	{ name: "analysis.scorecard", input: { id: "quality", metrics: [{ id: "correctness", value: 1, weight: 2 }, { id: "latency", value: 0.5, weight: 1 }] } },
	{ name: "analysis.calibrate", input: { values: [{ confidence: 0.9, correct: true }, { confidence: 0.1, correct: false }], bins: 2 } },
	{ name: "analysis.replay", input: { cases: [{ id: "case-1", expectedIds: ["a"], actualIds: ["a"] }] } },
	{ name: "analysis.trajectory", input: { id: "trajectory", events: [{ id: "later", at: "2026-01-02T00:00:00.000Z", label: "later" }, { id: "first", at: "2026-01-01T00:00:00.000Z", label: "first" }] } },
	{ name: "analysis.route.sources", input: { tenantId: "local", query: "parity", sources: [{ id: "source-a", tenantId: "local", priority: 2, healthy: true }, { id: "other", tenantId: "other", priority: 9, healthy: true }] } },
	{ name: "analysis.route.brains", input: { tenantId: "local", query: "parity", brains: [{ id: "brain-a", tenantId: "local", priority: 2, allowed: true }, { id: "other", tenantId: "other", priority: 9, allowed: true }] } },
	{ name: "analysis.recall", input: { records: [{ id: "memory-a", tenantId: "local", brainId: "brain", text: "parity contract" }, { id: "other", tenantId: "other", brainId: "brain", text: "parity contract" }], tenantId: "local", brainId: "brain", query: "parity" } },
	{ name: "analysis.contributor", input: { id: "capture-a", tenantId: "local", brainId: "brain", query: "parity review", consent: true } },
	{ name: "analysis.diagnose", input: { query: "parity", tenantId: "local", brainId: "brain", candidates: [{ tenantId: "local", brainId: "brain", verified: true }, { tenantId: "local", brainId: "brain", verified: false }, { tenantId: "other", brainId: "brain", verified: true }] } },
	{ name: "analysis.anomaly", input: { records: [{ id: "metric", tenantId: "local", brainId: "brain", baseline: 1, observed: 4, threshold: 1 }] } },
	{ name: "admin.audit.page", input: { limit: 10 } },
	{ name: "admin.token.list", input: {} },
	{ name: "jobs.schedules", input: {} },
	{ name: "skills.feedback.list", input: {} },
];

async function runStdio(repositoryRoot: string, storePath: string, requests: unknown[]): Promise<Array<Record<string, unknown>>> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["src/cli.ts", "serve", "--store", storePath], { cwd: process.cwd(), env: { ...process.env, MANAS_BRAIN_REPOSITORY: repositoryRoot } });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code !== 0) { reject(new Error(`stdio MCP exited with ${code}: ${stderr}`)); return; }
			try { resolve(stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)); } catch (error) { reject(error); }
		});
		child.stdin.end(requests.map((request) => JSON.stringify(request)).join("\n").concat("\n"));
	});
}

describe("catalog operation transport contract", () => {
	test("matches direct library, CLI, stdio MCP, HTTP MCP, and thin-client results", async () => {
		const root = await mkdtemp(join(tmpdir(), "catalog-transport-contract-"));
		const directStore = await openPgliteBrainStore();
		try {
			const repository = new BrainRepository(join(root, "brain"));
			await repository.initialize();
			const registry = createFullOperationRegistry({ repository, store: directStore, controlPlane: new DurableControlPlane(directStore) });
			const context = { scope: "admin" as const, principal: "transport-test", tenantId: "local" };
			const direct = new Map<string, unknown>();
			for (const fixture of fixtures) direct.set(fixture.name, await registry.execute(context, fixture.name, fixture.input));

			const cli = new Map<string, unknown>();
			for (const fixture of fixtures) {
				const result = await execFile(process.execPath, ["src/cli.ts", "operation", fixture.name, "--input", JSON.stringify(fixture.input), "--repo", repository.root, "--store", join(root, "cli-store")], { cwd: process.cwd(), env: process.env });
				cli.set(fixture.name, (JSON.parse(result.stdout) as { data: unknown }).data);
			}

			const requests = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, ...fixtures.map((fixture, index) => ({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name: fixture.name, arguments: fixture.input } }))];
			const stdioResponses = await runStdio(repository.root, join(root, "stdio-store"), requests);
			const stdio = new Map(fixtures.map((fixture, index) => {
				const response = stdioResponses[index + 1]!.result as { content: Array<{ text: string }> };
				return [fixture.name, JSON.parse(response.content[0]!.text) as unknown];
			}));

			const http = new Map<string, unknown>();
			for (const fixture of fixtures) {
				const response = await handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: fixture.name, arguments: fixture.input } }, registry, context) as { content: Array<{ text: string }> };
				http.set(fixture.name, JSON.parse(response.content[0]!.text) as unknown);
			}

			const thin = new Map<string, unknown>();
			for (const fixture of fixtures) {
				thin.set(fixture.name, await callMcpHttp("http://127.0.0.1:1", "0123456789abcdef", fixture.name, fixture.input, (async (_url: RequestInfo | URL, init?: RequestInit) => {
					const request = JSON.parse(String(init?.body)) as { params: { name: string; arguments: Record<string, unknown> } };
					const response = await handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: request.params }, registry, context) as { content: Array<{ text: string }> };
					return Response.json({ jsonrpc: "2.0", id: 1, result: response });
				}) as unknown as typeof fetch));
			}

			for (const fixture of fixtures) {
				expect(cli.get(fixture.name)).toEqual(direct.get(fixture.name));
				expect(stdio.get(fixture.name)).toEqual(direct.get(fixture.name));
				expect(http.get(fixture.name)).toEqual(direct.get(fixture.name));
				expect(thin.get(fixture.name)).toEqual(direct.get(fixture.name));
			}
		} finally { await directStore.close(); await rm(root, { recursive: true, force: true }); }
	}, 30_000);
});
