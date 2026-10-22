import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createBrainEngine, type BrainEngine } from "../src/engine";
import { defaultConfig } from "../src/config";
import { manageAgentHooks } from "../src/agent-hooks";
import { enqueueCaptureTurn, memoryCaptureHandler, stageCaptureTurn } from "../src/brain/memory-capture";
import { cancelJob, listJobs, runOneJob } from "../src/brain/jobs";
import { recall, forget } from "../src/brain/memory";
const owner = { scope: "admin" as const, tenantId: "local" };
async function fixture(work: (engine: BrainEngine, installationId: string, configure: (capture: boolean) => Promise<unknown>) => Promise<void>) {
 const root = await mkdtemp(join(tmpdir(), "manas-capture-"));
 const config = { ...defaultConfig({}), stateRoot: join(root, "state") };
 const home = join(root, "home");
 const options = { agent: "codex" as const, home, stateRoot: config.stateRoot, configPath: join(root, "config.json"), executable: [process.execPath, "cli.ts"] };
 const id = createHash("sha256").update("codex:" + home).digest("hex");
 let engine: BrainEngine | undefined;
 try {
  engine = await createBrainEngine({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store") });
  const run = promisify(execFile);
  await run("git", ["-C", engine.repository.root, "config", "user.name", "Test"]);
  await run("git", ["-C", engine.repository.root, "config", "user.email", "test@example.invalid"]);
  const configure = (capture: boolean) => manageAgentHooks({ ...options, capture }, "install");
  await configure(true);
  await work(engine, id, configure);
 } finally { await engine?.close(); await rm(root, { recursive: true, force: true }); }
}
test("capture retries replay persisted extraction after a commit and do not resurrect withdrawal", async () => fixture(async (engine, installationId) => {
 const prompt = "Telescope owner is Maya.";
 const input = { installationId, sessionId: "session", turnId: "turn", prompt };
 await stageCaptureTurn(engine.store!, engine.config.stateRoot, input, (await engine.repository.getIdentity()).brainId);
 await stageCaptureTurn(engine.store!, engine.config.stateRoot, input, (await engine.repository.getIdentity()).brainId);
 await expect(stageCaptureTurn(engine.store!, engine.config.stateRoot, { ...input, prompt: "changed" }, (await engine.repository.getIdentity()).brainId)).rejects.toMatchObject({ code: "idempotency_conflict" });
 const queued = await enqueueCaptureTurn(engine.store!, engine.config.stateRoot, input, (await engine.repository.getIdentity()).brainId);
 expect(await enqueueCaptureTurn(engine.store!, engine.config.stateRoot, input, (await engine.repository.getIdentity()).brainId)).toEqual(queued);
 let calls = 0;
 const handler = memoryCaptureHandler({ store: engine.store!, repository: engine.repository, stateRoot: engine.config.stateRoot, workerId: "worker", provider: { generate: async () => { calls++; return JSON.stringify({ spans: [{ start: 0, end: prompt.length }] }); } } });
 const query = engine.store!.query.bind(engine.store!);
 let crash = true;
 engine.store!.query = async (sql, parameters) => {
  if (crash && parameters?.includes("capture.complete")) { crash = false; throw new Error("simulated crash after Git write"); }
  return query(sql, parameters);
 };
 await expect(runOneJob(engine.store!, "worker", { "memory-capture": handler })).rejects.toThrow("simulated crash");
 expect((await listJobs(engine.store!))[0].progress).toMatchObject({ captureSpans: [{ start: 0, end: prompt.length }] });
 await runOneJob(engine.store!, "worker", { "memory-capture": handler });
 expect(calls).toBe(1);
 const memories = await recall(engine.repository, { ...owner, allowedAccessLabels: ["personal"] }, { query: "Telescope" });
 expect(memories.results).toHaveLength(1);
 expect(memories.results[0]).toMatchObject({ text: prompt, provenance: { sessionId: "session", turnId: "turn" }, visibility: ["personal"] });
 expect((await recall(engine.repository, { ...owner, allowedAccessLabels: [] }, { query: "Telescope" })).results).toEqual([]);
 const memory = memories.results[0];
 await forget(engine.repository, owner, { id: memory.id, expectedRevision: memory.revision, idempotencyKey: "withdraw" });
 expect((await enqueueCaptureTurn(engine.store!, engine.config.stateRoot, input, (await engine.repository.getIdentity()).brainId)).status).toBe("complete");
 expect((await recall(engine.repository, owner, { query: "Telescope" })).results).toEqual([]);
}));
test("capture requires current opt-in and rejects unsupported model source spans", async () => fixture(async (engine, installationId, configure) => {
 const initialHead = await engine.repository.head();
 const input = { installationId, sessionId: "session", turnId: "turn", prompt: "Telescope owner is Maya." };
 await engine.operations.execute(owner, "capture.stage", input);
 await engine.operations.execute(owner, "capture.enqueue", { installationId, sessionId: "session", turnId: "turn" });
 await configure(false);
 const handler = memoryCaptureHandler({ store: engine.store!, repository: engine.repository, stateRoot: engine.config.stateRoot, workerId: "worker", provider: { generate: async () => { throw new Error("must not call model"); } } });
 await expect(runOneJob(engine.store!, "worker", { "memory-capture": handler })).rejects.toThrow("disabled");
 expect(await engine.repository.head()).toBe(initialHead);
 await expect(enqueueCaptureTurn(engine.store!, engine.config.stateRoot, input, (await engine.repository.getIdentity()).brainId)).rejects.toThrow("disabled");
 const oldJob = (await listJobs(engine.store!))[0];
 await cancelJob(engine.store!, oldJob.id);
 await configure(true);
 await expect(stageCaptureTurn(engine.store!, engine.config.stateRoot, input, (await engine.repository.getIdentity()).brainId)).rejects.toThrow("older capture grant");
 const next = { ...input, turnId: "new-turn" };
 await stageCaptureTurn(engine.store!, engine.config.stateRoot, next, (await engine.repository.getIdentity()).brainId);
 await enqueueCaptureTurn(engine.store!, engine.config.stateRoot, next, (await engine.repository.getIdentity()).brainId);
 const invalid = memoryCaptureHandler({ store: engine.store!, repository: engine.repository, stateRoot: engine.config.stateRoot, workerId: "worker", provider: { generate: async () => JSON.stringify({ spans: [{ start: 0, end: 10000 }] }) } });
 await expect(runOneJob(engine.store!, "worker", { "memory-capture": invalid })).rejects.toThrow("source span");
 expect(await engine.repository.head()).toBe(initialHead);
}));


test("capture cancellation during local inference prevents Git writes", async () => fixture(async (engine, installationId) => {
 const initialHead = await engine.repository.head();
 const input = { installationId, sessionId: "session", turnId: "turn", prompt: "Telescope owner is Maya." };
 await stageCaptureTurn(engine.store!, engine.config.stateRoot, input, (await engine.repository.getIdentity()).brainId);
 const queued = await enqueueCaptureTurn(engine.store!, engine.config.stateRoot, input, (await engine.repository.getIdentity()).brainId);
 const handler = memoryCaptureHandler({ store: engine.store!, repository: engine.repository, stateRoot: engine.config.stateRoot, workerId: "worker", provider: { generate: async () => {
  await cancelJob(engine.store!, queued.jobId);
  return JSON.stringify({ spans: [{ start: 0, end: input.prompt.length }] });
 } } });
 expect(await runOneJob(engine.store!, "worker", { "memory-capture": handler })).toMatchObject({ status: "cancelled" });
 expect((await listJobs(engine.store!))[0].status).toBe("cancelled");
 expect(await engine.repository.head()).toBe(initialHead);
}));


test("queued capture survives engine restart and recovers after local model configuration", async () => fixture(async (engine, installationId) => {
 const input = { installationId, sessionId: "session", turnId: "turn", prompt: "Telescope owner is Maya." };
 await engine.operations.execute(owner, "capture.stage", input);
 await engine.operations.execute(owner, "capture.enqueue", { installationId, sessionId: "session", turnId: "turn" });
 await expect(engine.operations.execute(owner, "jobs.run-one", {})).rejects.toMatchObject({ code: "local_model_not_configured" });
 expect((await listJobs(engine.store!))[0]).toMatchObject({ status: "pending", attempts: 1 });
 const config = engine.config, repositoryRoot = engine.repository.root;
 await engine.close();
 const restarted = await createBrainEngine({ config, repositoryRoot, storePath: join(repositoryRoot, "..", "store"), providers: { generation: { id: "fixture-local", generate: async () => JSON.stringify({ spans: [{ start: 0, end: input.prompt.length }] }) } } });
 try {
  expect(await restarted.operations.execute(owner, "jobs.run-one", {})).toMatchObject({ job: { status: "complete", attempts: 2 } });
  expect((await recall(restarted.repository, owner, { query: "Telescope" })).results).toHaveLength(1);
  expect((await listJobs(restarted.store!))[0].progress).toMatchObject({ captureSpans: [{ start: 0, end: input.prompt.length }] });
 } finally { await restarted.close(); }
}));
