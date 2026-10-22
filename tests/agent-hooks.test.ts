import { createHash } from "node:crypto";
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manageAgentHooks } from "../src/agent-hooks";
import { runAgentHook } from "../src/agent-hook-runtime";
import { defaultConfig } from "../src/config";
test("hook installation retains unrelated settings and edited hooks without granting trust", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-hooks-"));
 try {
  for (const agent of ["codex", "claude-code"] as const) {
   const options = { agent, home: join(root, agent), stateRoot: join(root, "state"), configPath: join(root, "config 'quoted'.json"), executable: [process.execPath, "/a path/cli.ts"] };
   const target = join(options.home, agent === "codex" ? ".codex" : ".claude", agent === "codex" ? "hooks.json" : "settings.json");
   await mkdir(join(target, ".."), { recursive: true });
   const unrelated = { hooks: [{ type: "command", command: "existing-hook" }] };
   await writeFile(target, JSON.stringify({ theme: "existing", hooks: { SessionStart: [unrelated] } }));
   expect((await manageAgentHooks(options, "preview")).hooksInstalled).toBe(false);
   await manageAgentHooks(options, "install");
   await manageAgentHooks(options, "install");
   const status = await manageAgentHooks(options, "status");
   expect(status).toMatchObject({ hooksInstalled: true, integrationObserved: false, captureEnabled: false });
   if (agent === "codex") expect(status.hookTrust).toBe("requires-review");
   let settings = JSON.parse(await readFile(target, "utf8"));
   expect(settings.hooks.SessionStart).toHaveLength(2);
   expect(settings.theme).toBe("existing");
   settings.hooks.UserPromptSubmit[0].hooks[0].command += " user-edit";
   await writeFile(target, JSON.stringify(settings));
   await manageAgentHooks(options, "uninstall");
   settings = JSON.parse(await readFile(target, "utf8"));
   expect(settings.hooks.SessionStart).toEqual([unrelated]);
   expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toEndWith(" user-edit");
   expect(settings.theme).toBe("existing");
   await manageAgentHooks(options, "uninstall");
  }
 } finally { await rm(root, { recursive: true, force: true }); }
});
test("hook runtime returns immediately without a service and ignores unsupported events", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-hook-offline-"));
 try {
  const config = { ...defaultConfig({}), stateRoot: join(root, "state") };
  const start = Date.now();
  expect(await runAgentHook(config, "codex", { hook_event_name: "UserPromptSubmit", prompt: "project" })).toEqual({});
  expect(Date.now() - start).toBeLessThan(500);
  expect(await runAgentHook(config, "claude-code", { hook_event_name: "Stop", last_assistant_message: "generated fact" })).toEqual({});
 } finally { await rm(root, { recursive: true, force: true }); }
});


test("capture hook failures are inspectable without retaining prompt text or raw session IDs", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-hook-observed-"));
 try {
  const config = { ...defaultConfig({}), stateRoot: join(root, "state") };
  const home = join(root, "home");
  const options = { agent: "codex" as const, home, stateRoot: config.stateRoot, configPath: join(root, "config.json"), executable: [process.execPath, "cli.ts"], capture: true };
  await manageAgentHooks(options, "install");
  const id = createHash("sha256").update("codex:" + home).digest("hex");
  await runAgentHook(config, "codex", { hook_event_name: "Stop", session_id: "private-session" }, id);
  const status = await manageAgentHooks(options, "status");
  expect(status).toMatchObject({ captureEnabled: true, integrationObserved: false, hookInvocationObserved: true, observations: [{ event: "Stop", outcome: "capture_failed", code: "capture_identity_missing" }] });
  expect(JSON.stringify(status.observations)).not.toContain("private-session");
  await runAgentHook(config, "codex", { hook_event_name: "UserPromptSubmit", session_id: "private-session", turn_id: "turn", prompt: "Confidential personal source" }, id);
  const unavailable = await manageAgentHooks(options, "status");
  expect(unavailable.observations.find((value) => value.event === "UserPromptSubmit")).toMatchObject({ outcome: "capture_failed", code: "service_unavailable" });
  expect(JSON.stringify(unavailable.observations)).not.toContain("Confidential");
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("hook update journals retain old groups across retries and status reads the stored capture grant", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-hook-journal-"));
 try {
  const options = { agent: "claude-code" as const, home: join(root, "home"), stateRoot: join(root, "state"), configPath: join(root, "config.json"), executable: [process.execPath, "/old/cli.ts"], capture: true, visibility: ["private"] };
  await manageAgentHooks(options, "install");
  const target = join(options.home, ".claude", "settings.json");
  const oldConfig = await readFile(target, "utf8");
  const id = createHash("sha256").update(options.agent + ":" + options.home).digest("hex");
  const receiptPath = join(options.stateRoot, "agent-integrations", id + "-hooks.json");
  const oldReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const nextOptions = { ...options, executable: [process.execPath, "/new/cli.ts"] };
  await manageAgentHooks(nextOptions, "install");
  const nextReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await writeFile(target, oldConfig);
  await writeFile(receiptPath, JSON.stringify({ ...nextReceipt, captureEnabled: false, previousGroup: oldReceipt.group, previousEvents: oldReceipt.events }));
  await manageAgentHooks(nextOptions, "install");
  const actual = JSON.parse(await readFile(target, "utf8"));
  expect(actual.hooks.Stop).toHaveLength(1);
  expect(actual.hooks.Stop[0].hooks[0].command).toContain("/new/cli.ts");
  const status = await manageAgentHooks({ ...nextOptions, capture: undefined, visibility: undefined }, "status");
  expect(status).toMatchObject({ captureEnabled: true, grantedVisibility: ["private"] });
  await manageAgentHooks(nextOptions, "uninstall");
  expect(JSON.parse(await readFile(receiptPath, "utf8")).captureEnabled).toBe(false);
 } finally { await rm(root, { recursive: true, force: true }); }
});
