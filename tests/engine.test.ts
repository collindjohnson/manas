import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";

const { createBrainEngine, createConfiguredBrainEngine } = await import("../src/engine");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("library engine factory", () => {
	test("creates and closes a repository-only engine", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-engine-"));
		roots.push(root);
		const engine = await createBrainEngine({ repositoryRoot: join(root, "brain") });
		expect((await engine.repository.getIdentity()).brainId).toBeString();
		await expect(engine.close()).resolves.toBeUndefined();
	});

	test("shares configured retrieval providers with its operation registry", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-engine-registry-"));
		roots.push(root);
		let calls = 0;
		const engine = await createBrainEngine({ repositoryRoot: join(root, "brain"), storePath: join(root, "state"), config: defaultConfig({}), providers: { reranking: { id: "test", rerank: async (_query, documents) => { calls++; return documents.map((document) => ({ id: document.id, score: 1 })); } } } });
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			await promisify(execFile)("git", ["-C", engine.repository.root, "config", "user.name", "Test"]);
			await promisify(execFile)("git", ["-C", engine.repository.root, "config", "user.email", "test@example.invalid"]);
			await engine.repository.putPage("notes/example.md", "Juniper project ownership belongs to Maya.");
			const { indexBrainRepository } = await import("../src/brain/pglite-indexer");
			await indexBrainRepository(engine.store!, engine.repository);
			const result = await engine.operations.execute({ scope: "read", tenantId: "local" }, "retrieval.search", { query: "Juniper" });
			expect(result).toMatchObject({ results: [{ path: "notes/example.md", verifiedText: "Juniper project ownership belongs to Maya." }] });
			expect(calls).toBe(1);
			await engine.operations.execute({ scope: "admin", tenantId: "local" }, "jobs.enqueue", { type: "index", payload: { repositoryRoot: engine.repository.root }, idempotencyKey: "engine-worker" });
			expect(await engine.operations.execute({ scope: "admin", tenantId: "local" }, "jobs.run-one", {})).toMatchObject({ job: { type: "index", status: "complete" } });
			await expect(engine.operations.execute({ scope: "read" }, "jobs.run-one", {})).rejects.toThrow("scope");

		} finally { await engine.close(); }
	});

	test("constructs configured providers and auth from a config file", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-engine-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		await Bun.write(configPath, JSON.stringify({
			providers: { embedding: { endpoint: "http://127.0.0.1:11434/v1/embeddings", model: "local-embedding", privacy: "local", dimensions: 2 } },
			auth: { oauth: { clients: [{ id: "engine-client", redirectUris: ["http://127.0.0.1/callback"], allowedScopes: ["read"], confidential: false }] }, session: { idleMs: 4_000, absoluteMs: 8_000 } },
		}));
		const engine = await createConfiguredBrainEngine({ repositoryRoot: join(root, "brain"), config: { filePath: configPath } });
		try {
			expect(engine.providers.embedding?.model.id).toBe("local-embedding");
			expect(engine.auth.sessions.create("user", "tenant").expiresAt).toBeString();
			expect(engine.auth.oauth.isRegisteredRedirect("engine-client", "http://127.0.0.1/callback")).toBe(true);
		} finally { await engine.close(); }
	});

	test("reopens a configured durable OAuth service without duplicating clients", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-engine-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		const storePath = join(root, "store");
		await Bun.write(configPath, JSON.stringify({ auth: { oauth: { clients: [{ id: "durable-client", redirectUris: ["http://127.0.0.1/callback"], allowedScopes: ["read"], confidential: false }] } } }));
		const first = await createConfiguredBrainEngine({ repositoryRoot: join(root, "brain"), storePath, config: { filePath: configPath } });
		await first.close();
		const second = await createConfiguredBrainEngine({ repositoryRoot: join(root, "brain"), storePath, config: { filePath: configPath } });
		try {
			expect(await second.auth.oauth.isRegisteredRedirect("durable-client", "http://127.0.0.1/callback")).toBe(true);
		} finally { await second.close(); }
	});
});
