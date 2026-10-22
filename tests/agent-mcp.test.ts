import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { manageAgentMcp, liveClientRegistry, resolveClientGrant } from "../src/agent-mcp";
import { OperationRegistry } from "../src/brain/operation-registry";

test("managed MCP preserves unrelated settings, resumes journaled updates, and revokes edited installs", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-mcp-install-"));
 try {
  for (const agent of ["codex", "claude-code"] as const) {
   const options = { agent, home: join(root, agent), stateRoot: join(root, "state"), configPath: join(root, "config.json"), executable: [process.execPath, "/a path/cli.ts"] };
   const path = join(options.home, agent === "codex" ? ".codex/config.toml" : ".claude.json");
   await mkdir(join(path, ".."), { recursive: true });
   const original = agent === "codex" ? 'model = "existing"\n[mcp_servers.other]\ncommand = "other"\n' : JSON.stringify({ theme: "existing", mcpServers: { other: { command: "other" } } });
   await writeFile(path, original);
   const installed = await manageAgentMcp(options, "install");
   expect(installed).toMatchObject({ configurationInstalled: true, grantActive: true, scope: "read", visibility: [] });
   const oldReceipt = JSON.parse(await readFile(join(options.stateRoot, "agent-integrations", installed.clientId + "-mcp.json"), "utf8"));
   const oldConfiguration = await readFile(path, "utf8");
   await manageAgentMcp({ ...options, executable: [process.execPath, "/new/cli.ts"], write: true, visibility: ["personal"] }, "install");
   const receiptPath = join(options.stateRoot, "agent-integrations", installed.clientId + "-mcp.json");
   const newReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
   // Simulate process death after journal write and before replacing the old config.
   await writeFile(receiptPath, JSON.stringify({ ...newReceipt, previousEntry: oldReceipt.entry, previousBlock: oldReceipt.block }));
   await writeFile(path, oldConfiguration);
   await manageAgentMcp({ ...options, executable: [process.execPath, "/new/cli.ts"], write: true }, "install");
   expect((await readFile(path, "utf8"))).toContain("existing");
   const edited = (await readFile(path, "utf8")).replace("/new/cli.ts", "/user/edited.ts");
   await writeFile(path, edited);
   expect(await manageAgentMcp(options, "uninstall")).toMatchObject({ grantActive: false, removed: false, preserved: true });
   expect(await readFile(path, "utf8")).toBe(edited);
   await expect(resolveClientGrant(options.stateRoot, installed.clientId)).rejects.toThrow("revoked");
  }
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("unowned MCP entries conflict and exact owned installs uninstall cleanly", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-mcp-conflict-"));
 try {
  for (const agent of ["codex", "claude-code"] as const) {
   const options = { agent, home: join(root, agent), stateRoot: join(root, "state"), configPath: join(root, "config.json"), executable: [process.execPath] };
   const initial = await manageAgentMcp(options, "install");
   await manageAgentMcp(options, "uninstall");
   expect((await manageAgentMcp(options, "status")).configurationInstalled).toBe(false);
   await manageAgentMcp(options, "install");
   // Identical bytes without an ownership receipt must not be adopted.
   await rm(join(options.stateRoot, "agent-integrations", initial.clientId + "-mcp.json"));
   expect((await manageAgentMcp(options, "preview")).action).toBe("conflict");
   await expect(manageAgentMcp(options, "install")).rejects.toThrow("not owned");
  }
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("connected clients recheck grants and discard results if visibility changes in flight", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-mcp-revoke-"));
 try {
  const options = { agent: "claude-code" as const, home: join(root, "home"), stateRoot: join(root, "state"), configPath: join(root, "config.json"), executable: [process.execPath], visibility: ["personal"] };
  const install = await manageAgentMcp(options, "install");
  const original = new OperationRegistry();
  let change = false;
  original.register({ name: "search", description: "search", inputSchema: {}, outputSchema: {}, requiredScope: "read", trustBoundary: "remote-safe", execute: async (context) => {
   expect(context.allowedAccessLabels).toEqual(["personal"]);
   if (change) await manageAgentMcp({ ...options, visibility: [] }, "install");
   return { text: "private" };
  } });
  original.register({ name: "sources.list", description: "Owner metadata", inputSchema: {}, outputSchema: {}, requiredScope: "read", trustBoundary: "remote-safe", execute: async () => ({ private: true }) });
 const client = await liveClientRegistry(original, options.stateRoot, install.clientId);
 expect(client.list().some((entry) => entry.name === "sources.list")).toBe(false);
  expect(await client.execute({ scope: "admin" }, "search", {})).toEqual({ text: "private" });
  change = true;
  await expect(client.execute({ scope: "admin" }, "search", {})).rejects.toThrow("revoked");
  await manageAgentMcp(options, "uninstall");
  await expect(client.execute({ scope: "admin" }, "search", {})).rejects.toThrow("revoked");
 } finally { await rm(root, { recursive: true, force: true }); }
});
