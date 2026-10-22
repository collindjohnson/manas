import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { defaultConfig } from "../src/config";
import { startLocalService, callLocalService } from "../src/local-service";
import { manageAgentHooks } from "../src/agent-hooks";
for (const agent of ["codex", "claude-code"] as const) test(agent + " hook queues a stable turn while the service performs local capture", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-capture-service-"));
 const prompt = "Juniper maintainer is Maya.";
 let modelCalls = 0;
 const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
  expect(request.url).toEndWith("/v1/chat/completions");
  const body = await request.json() as { response_format: { type: string }; messages: Array<{ content: string }> };
  expect(body.messages[0].content).toContain(prompt);
  expect(body.response_format).toEqual({ type: "json_object" });
  modelCalls++;
  return Response.json({ choices: [{ message: { content: JSON.stringify({ spans: [{ start: 0, end: prompt.length }] }) } }] });
 } });
 const config = { ...defaultConfig({}), stateRoot: join(root, "state"), providers: { reranking: { model: "reranker-fixture", endpoint: "http://127.0.0.1:" + model.port + "/v1/rerank", privacy: "local" as const }, generation: { model: "capture-fixture", endpoint: "http://127.0.0.1:" + model.port + "/v1/chat/completions", privacy: "local" as const } } };
 const configPath = join(root, "config.json"), home = join(root, "home");
 const installationId = createHash("sha256").update(agent + ":" + home).digest("hex");
 const failures: unknown[] = [];
 try {
  await writeFile(configPath, JSON.stringify(config));
  const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), onWorkerError: (error) => failures.push(error) });
  try {
   const run = promisify(execFile);
   await run("git", ["-C", service.engine.repository.root, "config", "user.name", "Test"]);
   await run("git", ["-C", service.engine.repository.root, "config", "user.email", "test@example.invalid"]);
   await manageAgentHooks({ agent, home, stateRoot: config.stateRoot, configPath, executable: [process.execPath, "src/cli.ts"], capture: true }, "install");
   const transcriptPath = join(home, ".claude", "projects", "project", "session.jsonl");
   if (agent === "claude-code") {
    await mkdir(join(transcriptPath, ".."), { recursive: true });
    await writeFile(transcriptPath, JSON.stringify({ type: "user", uuid: "turn", sessionId: "session", timestamp: new Date().toISOString(), message: { role: "user", content: prompt } }) + "\n");
   }
   const hook = async (event: Record<string, unknown>) => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "--config", configPath, "hook", "--agent", agent, "--installation", installationId], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify({ session_id: "session", turn_id: "turn", transcript_path: transcriptPath, ...event }));
    child.stdin.end();
    const start = Date.now();
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(errors).toBe(""); expect(Date.now() - start).toBeLessThan(2000);
    return JSON.parse(output);
   };
   await hook({ hook_event_name: "UserPromptSubmit", prompt });
   expect(modelCalls).toBe(0);
   expect(await hook({ hook_event_name: "Stop", last_assistant_message: "Unsupported generated fact" })).toEqual({});
   expect(await hook({ hook_event_name: "Stop" })).toEqual({});
   let jobs: Array<{ type: string; status: string }> = [];
   for (let attempt = 0; attempt < 100; attempt++) {
    jobs = await callLocalService(config, "jobs.list") as typeof jobs;
    if (jobs.some((job) => job.type === "memory-capture" && ["complete", "failed"].includes(job.status))) break;
    await new Promise((done) => setTimeout(done, 30));
   }
   expect(jobs.filter((job) => job.type === "memory-capture")).toMatchObject([{ status: "complete" }]);
   expect(modelCalls).toBe(1);
   expect(failures).toEqual([]);
   const result = await callLocalService(config, "memory.recall", { query: "Juniper" }, { context: { scope: "read", allowedAccessLabels: ["personal"] } }) as { results: Array<{ text: string }> };
   expect(result.results.map((memory) => memory.text)).toEqual([prompt]);
   expect(await hook({ hook_event_name: "UserPromptSubmit", prompt })).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining(prompt) } });
   expect(modelCalls).toBe(1);
  } finally { await service.close(); }
 } finally { model.stop(true); await rm(root, { recursive: true, force: true }); }
}, 15000);
