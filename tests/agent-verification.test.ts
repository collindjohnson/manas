import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { startLocalService, callLocalService } from "../src/local-service";
import { manageAgentHooks } from "../src/agent-hooks";
import { recordHookObservation } from "../src/agent-hook-observations";
import { verifyAgentIntegration, type NativeVerificationRunner } from "../src/agent-verification";
import { verificationInstallationId } from "../src/agent-verification-state";
import type { ContextDelivery } from "../src/brain/context-delivery";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

for (const agent of ["codex", "claude-code"] as const) test(agent + " verification binds native citations and matching hook sessions to current configuration", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-agent-verification-test-"));
 const config = { ...defaultConfig({}), stateRoot: join(root, "state"), archiveRoot: join(root, "archive") };
 const configPath = join(root, "config.json");
 const options = { agent, home: join(root, "home"), stateRoot: config.stateRoot, configPath, executable: [process.execPath, "src/cli.ts"] };
 const installationId = verificationInstallationId(options);
 await writeFile(configPath, JSON.stringify(config));
 const service = await startLocalService({ config, repositoryRoot: join(root, "brain"), storePath: join(root, "store"), worker: false });
 const run = promisify(execFile);
 try {
  await run("git", ["-C", service.engine.repository.root, "config", "user.name", "Verification fixture"]);
  await run("git", ["-C", service.engine.repository.root, "config", "user.email", "fixture@example.invalid"]);
  await expect(verifyAgentIntegration(config, options, "Juniper")).rejects.toMatchObject({ code: "hooks_not_installed" });
  await manageAgentHooks(options, "install");
  await expect(verifyAgentIntegration(config, options, "Juniper")).rejects.toMatchObject({ code: "verification_evidence_missing" });
  const seed = await callLocalService(config, "memory.remember", { text: "Juniper owner is Mara.", provenance: { sourceType: "user" }, idempotencyKey: "verification-seed" }) as { id: string; revision: string };
  const evidence = await callLocalService(config, "context.deliver", { query: "Juniper" }, { context: { scope: "read", allowedAccessLabels: [] } }) as ContextDelivery;
  let session = 0;
  const runner: NativeVerificationRunner = async () => {
   const sessionId = "native-test-" + ++session;
   await recordHookObservation(config.stateRoot, installationId, { hook_event_name: "UserPromptSubmit", session_id: sessionId }, "delivered");
   return { sessionId, nativeVersion: "injected-unit-fixture", answer: { answer: "Mara", citations: evidence.citations }, noToolCalls: true };
  };
  expect((await manageAgentHooks(options, "status")).integrationObserved).toBe(false);
  expect(await verifyAgentIntegration(config, options, "Juniper", runner)).toMatchObject({ integrationObserved: true, automaticCaptureVerified: false });
  const verified = await manageAgentHooks(options, "status");
  expect(verified).toMatchObject({ hooksInstalled: true, integrationObserved: true, hookTrust: "observed-at-verification", verification: { nativeVersion: "injected-unit-fixture", trustMode: "normal-client-policy" } });
  expect(JSON.stringify(verified.verification)).not.toContain("native-test-");
  expect(JSON.stringify(verified.verification)).not.toContain("Juniper");
  await expect(verifyAgentIntegration(config, options, "Juniper", async () => ({ sessionId: "unobserved", nativeVersion: "fixture", answer: { answer: "Mara", citations: evidence.citations }, noToolCalls: true }))).rejects.toMatchObject({ code: "verification_context_missing" });
  expect((await manageAgentHooks(options, "status")).integrationObserved).toBe(false);
  await expect(verifyAgentIntegration(config, options, "Juniper", async (...args) => { const result = await runner(...args); return { ...result, noToolCalls: false }; })).rejects.toMatchObject({ code: "verification_session_invalid" });
  await expect(verifyAgentIntegration(config, options, "Juniper", async (...args) => { const result = await runner(...args); return { ...result, answer: { answer: "Mara", citations: [{ ...evidence.citations[0], endOffset: evidence.citations[0]!.endOffset + 1 }] } }; })).rejects.toMatchObject({ code: "verification_context_missing" });
  await verifyAgentIntegration(config, options, "Juniper", runner);
  await writeFile(configPath, JSON.stringify({ ...config, automation: { managedWrites: true } }));
  expect((await manageAgentHooks(options, "status")).integrationObserved).toBe(false);
  await writeFile(configPath, JSON.stringify(config));
  await expect(verifyAgentIntegration(config, options, "Juniper", async (...args) => { const result = await runner(...args); await manageAgentHooks({ ...options, visibility: ["personal"] }, "install"); return result; })).rejects.toThrow("configuration changed");
  expect((await manageAgentHooks(options, "status")).integrationObserved).toBe(false);
  await manageAgentHooks(options, "install");
  await verifyAgentIntegration(config, options, "Juniper", runner);
  await manageAgentHooks(options, "install");
  expect((await manageAgentHooks(options, "status")).integrationObserved).toBe(false);
  await verifyAgentIntegration(config, options, "Juniper", runner);
  const path = (await manageAgentHooks(options, "status")).path;
  const settings = JSON.parse(await readFile(path, "utf8"));
  settings.hooks.UserPromptSubmit[0].hooks[0].command += " edited";
  await writeFile(path, JSON.stringify(settings));
  expect((await manageAgentHooks(options, "status")).integrationObserved).toBe(false);
  await manageAgentHooks(options, "uninstall");
  expect((await manageAgentHooks(options, "status")).integrationObserved).toBe(false);
  await manageAgentHooks(options, "install");
  expect((await manageAgentHooks(options, "status")).integrationObserved).toBe(false);
  let started!: () => void, finish!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const first = verifyAgentIntegration(config, options, "Juniper", async (...args) => { started(); await pending; return runner(...args); });
  await running;
  await expect(verifyAgentIntegration(config, options, "Juniper", runner)).rejects.toMatchObject({ code: "verification_in_progress", retryable: true });
  finish();
  await first;
  await expect(verifyAgentIntegration(config, options, "Juniper", async (...args) => {
   const result = await runner(...args);
   await callLocalService(config, "memory.forget", { id: seed.id, expectedRevision: seed.revision, idempotencyKey: "verification-withdrawal" });
   return result;
  })).rejects.toMatchObject({ code: "verification_evidence_changed" });
  expect((await manageAgentHooks(options, "status")).integrationObserved).toBe(false);
 } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
}, 20000);

test("agent verify CLI reports structured installation errors without launching a native client", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-agent-verification-cli-"));
 try {
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ ...defaultConfig({}), stateRoot: join(root, "state") }));
  const child = Bun.spawn([process.execPath, "src/cli.ts", "--config", configPath, "agents", "verify", "codex", "--home", join(root, "home"), "--query", "Juniper"], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1); expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({ ok: false, command: "agents", error: { code: "hooks_not_installed", retryable: false, suggestedFix: expect.any(String) } });
 } finally { await rm(root, { recursive: true, force: true }); }
});
