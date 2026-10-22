import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { defaultConfig } from "../src/config";
import { startLocalService, callLocalService, localServiceRegistry } from "../src/local-service";
import { handleMcpHttpRequest } from "../src/mcp/http";
const execFile = promisify(execFileCallback);
test("CLI, stdio, HTTP MCP, and service restart share durable memory receipts", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-memory-transports-"));
 const config = { ...defaultConfig({}), stateRoot: join(root, "state") };
 const configPath = join(root, "config.json");
 await Bun.write(configPath, JSON.stringify(config));
 let service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), worker: false });
 try {
  await execFile("git", ["-C", service.engine.repository.root, "config", "user.name", "Test"]);
  await execFile("git", ["-C", service.engine.repository.root, "config", "user.email", "test@example.invalid"]);
  const input = { text: "Juniper owner is Maya.", idempotencyKey: "capture:session:turn", provenance: { sourceType: "user", sessionId: "session", turnId: "turn" } };
  const cli = await execFile(process.execPath, ["src/cli.ts", "--config", configPath, "remember", "--input", JSON.stringify(input)], { cwd: process.cwd() });
  const first = JSON.parse(cli.stdout).data as { id: string; revision: string };
  expect(first.id).toBeString();
  const stdio = await new Promise<Array<{ id: number; result?: { content: Array<{ text: string }> }; error?: { data?: { code: string } } }>>((resolve, reject) => {
   const child = spawn(process.execPath, ["src/cli.ts", "--config", configPath, "serve"], { cwd: process.cwd(), env: { ...process.env, MANAS_BRAIN_REPOSITORY: service.engine.repository.root } });
   let output = "", stderr = "";
   child.stdout.on("data", (data) => { output += data; });
   child.stderr.on("data", (data) => { stderr += data; });
   child.on("error", reject);
   child.on("close", (code) => { if (code) reject(new Error(stderr)); else { try { resolve(output.trim().split("\n").map((line) => JSON.parse(line))); } catch (error) { reject(error); } } });
   child.stdin.end([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory.remember", arguments: input } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory.remember", arguments: { ...input, text: "Conflicting capture" } } },
   ].map((request) => JSON.stringify(request)).join("\n") + "\n");
  });
  expect(JSON.parse(stdio.find((response) => response.id === 1)!.result!.content[0]!.text)).toMatchObject({ id: first.id, replayed: true });
  expect(stdio.find((response) => response.id === 2)?.error?.data?.code).toBe("idempotency_conflict");
  const registry = await localServiceRegistry(config);
  const http = await handleMcpHttpRequest(config, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory.recall", arguments: { query: "Juniper" } } }, registry, { scope: "read", tenantId: "local", allowedAccessLabels: [] }) as { content: Array<{ text: string }> };
  expect(JSON.parse(http.content[0]!.text)).toMatchObject({ results: [{ id: first.id, text: input.text }] });
  await callLocalService(config, "memory.forget", { id: first.id, expectedRevision: first.revision, idempotencyKey: "withdraw" });
  await service.close();
  service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), worker: false });
  expect(await callLocalService(config, "memory.recall", { query: "Juniper" })).toMatchObject({ results: [] });
  expect(await callLocalService(config, "retrieval.search", { query: "Juniper" })).toMatchObject({ results: [] });
  expect(await callLocalService(config, "memory.remember", input)).toMatchObject({ id: first.id, replayed: true, currentStatus: "withdrawn" });
 } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
