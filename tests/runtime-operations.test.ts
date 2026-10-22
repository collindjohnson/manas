import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import { defaultConfig } from "../src/config";
import { startLocalService } from "../src/local-service";
import { createBrainEngine } from "../src/engine";
const execFile = promisify(callback);
const owner = { scope: "admin" as const, principal: "owner", tenantId: "local" };
test("legacy model flags, extraction, traversal, jobs and auth share the configured service", async () => {
 const root = await mkdtemp(join(tmpdir(), "runtime-cli-"));
 let embeddedRequests = 0, transcriptionRequests = 0, rerankingRequests = 0;
 const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
  if (new URL(request.url).pathname === "/transcribe") {
   transcriptionRequests++;
   expect((await request.formData()).get("model")).toBe("local-audio");
   return Response.json({ text: "A locally transcribed fixture." });
  }
  if (new URL(request.url).pathname === "/rerank") {
   rerankingRequests++;
   const body = await request.json() as { model: string; documents: string[] };
   expect(body.model).toBe("local-reranker");
   return Response.json({ results: body.documents.map((_, index) => ({ index, relevance_score: 1 })) });
  }
  embeddedRequests++;
  const body = await request.json() as { input: string[]; model: string };
  expect(body.model).toBe("local-vectors");
  return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
 } });
 const embedding = { endpoint: model.url.origin + "/embeddings", model: "local-vectors", dimensions: 2, privacy: "local" as const };
 const config = { ...defaultConfig({}), stateRoot: join(root, "state"), providers: { embedding, reranking: { endpoint: model.url.origin + "/rerank", model: "local-reranker", privacy: "local" as const }, transcription: { endpoint: model.url.origin + "/transcribe", model: "local-audio", privacy: "local" as const } } };
 const configPath = join(root, "config.json"), repositoryRoot = join(root, "brain"), store = join(root, "store");
 const env = { ...process.env, GIT_AUTHOR_NAME: "Runtime Test", GIT_AUTHOR_EMAIL: "runtime@example.invalid", GIT_COMMITTER_NAME: "Runtime Test", GIT_COMMITTER_EMAIL: "runtime@example.invalid" };
 const cli = async (...args: string[]) => JSON.parse((await execFile(process.execPath, ["src/cli.ts", "--config", configPath, ...args], { env })).stdout).data;
 const flags = ["--embedding-endpoint", embedding.endpoint, "--embedding-model", embedding.model, "--embedding-dimensions", "2"];
 let service: Awaited<ReturnType<typeof startLocalService>> | undefined;
 try {
  await writeFile(configPath, JSON.stringify(config));
  const plain = join(root, "plain.txt");
  await writeFile(plain, "Standalone plain extraction.");
  expect(await cli("brain", "extract", "--file", plain)).toMatchObject({ metadata: { extractor: "plain-text" } });
  await cli("brain", "init", "--repo", repositoryRoot);
  await cli("brain", "put", "--repo", repositoryRoot, "--path", "facts.md", "--content", "Quasar database maintenance belongs to Maya.");
  expect(await cli("brain", "embed", "--repo", repositoryRoot, "--store", store, ...flags)).toMatchObject({ embedded: 1, dimensions: 2 });
  expect((await cli("brain", "search", "--repo", repositoryRoot, "--store", store, "--query", "Quasar", "--semantic", ...flags)).results.some((result: { verifiedText: string }) => result.verifiedText.includes("Maya"))).toBe(true);
  const beforeService = embeddedRequests;
  service = await startLocalService({ config, repositoryRoot, storePath: store, worker: false });
  expect(await cli("brain", "embed", "--repo", repositoryRoot, "--store", store, ...flags)).toMatchObject({ embedded: 0 });
  expect(embeddedRequests).toBe(beforeService);
  const expanded = await cli("brain", "search", "--repo", repositoryRoot, "--store", store, "--query", "Quasar db", "--expand");
  expect(expanded.variants).toContain("Quasar database");
  expect(expanded.results[0].verifiedText).toContain("Maya");
  expect(embeddedRequests).toBe(beforeService);
  const beforeRerank = rerankingRequests;
  expect((await cli("brain", "search", "--repo", repositoryRoot, "--query", "Quasar", "--reranker-endpoint", config.providers.reranking.endpoint, "--reranker-model", "local-reranker")).results[0].verifiedText).toContain("Maya");
  expect(rerankingRequests).toBe(beforeRerank + 1);
  expect(embeddedRequests).toBe(beforeService);
  await expect(cli("brain", "search", "--repo", repositoryRoot, "--query", "Quasar", "--semantic", ...flags.slice(0, 3), "different-model", ...flags.slice(4))).rejects.toMatchObject({ stdout: expect.stringContaining("provider_config_mismatch") });
  await expect(cli("brain", "embed", "--repo", repositoryRoot, "--allow-hosted-model")).rejects.toMatchObject({ stdout: expect.stringContaining("local_inference_required") });
  expect(embeddedRequests).toBe(beforeService);
  const audio = join(root, "fixture.wav");
  await writeFile(audio, Buffer.from("RIFFfixture-audio", "utf8"));
  expect(await cli("brain", "extract", "--repo", repositoryRoot, "--file", audio)).toMatchObject({ metadata: { extractor: "local-transcription", model: "local-audio" } });
  expect(transcriptionRequests).toBe(1);
  expect(await cli("brain", "verify", "--repo", repositoryRoot)).toMatchObject({ valid: true });
  expect(await cli("brain", "doctor", "--repo", repositoryRoot, "--store", store)).toMatchObject({ ok: true, projection: { current: true } });
  expect(await cli("brain", "schema", "--repo", repositoryRoot, "--candidates")).toHaveProperty("candidates");
  expect(await cli("brain", "sources-list", "--repo", repositoryRoot)).toEqual({ sources: [] });
  const job = await cli("jobs", "enqueue-index", "--repo", repositoryRoot, "--store", store, "--at", "2099-01-01T00:00:00Z");
  expect(await cli("jobs", "list", "--store", store, "--limit", "1")).toMatchObject({ jobs: [{ id: job.job.id, status: "pending" }] });
  expect(await cli("jobs", "cancel", "--store", store, "--id", job.job.id)).toEqual({ cancelled: job.job.id });
  const created = await cli("auth", "create", "--store", store, "--name", "fixture client", "--scopes", "read");
  expect(await cli("auth", "list", "--store", store)).toMatchObject({ tokens: [{ id: created.record.id }] });
  expect(await cli("auth", "revoke", "--store", store, "--id", created.record.id)).toEqual({ revoked: created.record.id });
  expect(await cli("auth", "revoke", "--store", store, "--id", created.record.id)).toEqual({ revoked: created.record.id });
  expect(await cli("auth", "events", "--store", store)).toHaveProperty("events");
 } finally { await service?.close(); await model.stop(true); await rm(root, { recursive: true, force: true }); }
}, 30000);
test("catalog wiki traversal filters private intermediates and runtime operations require owner scope", async () => {
 const root = await mkdtemp(join(tmpdir(), "runtime-traversal-"));
 const config = { ...defaultConfig({}), stateRoot: join(root, "state") };
 const engine = await createBrainEngine({ repositoryRoot: join(root, "brain"), storePath: join(root, "store"), config });
 try {
  await execFile("git", ["-C", engine.repository.root, "config", "user.name", "Test"]);
  await execFile("git", ["-C", engine.repository.root, "config", "user.email", "test@example.invalid"]);
  await engine.repository.putPage("start.md", "Inspect [[middle.md]].");
  const middle = await engine.repository.putPage("middle.md", "Inspect [[end.md]].");
  await engine.repository.setPageAccessLabels(middle.path, ["private"], middle.revision, middle.commit);
  await engine.repository.putPage("end.md", "Public endpoint evidence.");
  expect(await engine.operations.execute({ scope: "read", allowedAccessLabels: [] }, "retrieval.traverse", { path: "start.md", depth: 3 })).toEqual({ pages: [] });
  expect(await engine.operations.execute({ scope: "read", allowedAccessLabels: ["private"] }, "retrieval.traverse", { path: "start.md", depth: 3 })).toMatchObject({ pages: [{ path: "middle.md", depth: 1 }, { path: "end.md", depth: 2 }] });
  await expect(engine.operations.execute({ ...owner, allowedAccessLabels: [] }, "runtime.doctor", {})).rejects.toMatchObject({ code: "owner_access_required" });
  await expect(engine.operations.execute(owner, "projection.embed", {})).rejects.toMatchObject({ code: "local_model_not_configured" });
  const file = join(root, "plain.txt");
  await writeFile(file, "Local extraction without knowledge mutation.");
  const head = await engine.repository.head();
  expect(await engine.operations.execute(owner, "runtime.extract", { path: file })).toMatchObject({ metadata: { extractor: "plain-text" } });
  expect(await engine.repository.head()).toBe(head);
 } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});
