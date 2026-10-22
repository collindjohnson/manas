import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { previewAgentInstallation, installAgentSkills, uninstallAgentSkills, agentInstallationStatus } from "../src/agent-management";

test("agent skill ownership survives retries and preserves edits and existing settings", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-agents-"));
 try {
  for (const agent of ["codex", "claude-code"] as const) {
   const options = { agent, home: join(root, agent), stateRoot: join(root, "state") };
   await mkdir(join(options.home, ".codex"), { recursive: true });
   const settings = join(options.home, ".codex", "config.toml");
   await writeFile(settings, 'model = "existing"\n');
   expect((await previewAgentInstallation(options)).files.every((file) => file.action === "create")).toBe(true);
   const installed = await installAgentSkills(options);
   expect(installed.configurationInstalled).toBe(true);
   expect(installed.verificationScope).toBe("skills-only");
   expect((await installAgentSkills(options)).configurationInstalled).toBe(true);
   await writeFile(installed.files[0].path, "user edited skill");
   expect((await agentInstallationStatus(options)).configurationInstalled).toBe(false);
   const removed = await uninstallAgentSkills(options);
   expect(removed.removed).toHaveLength(4);
   expect(removed.preserved).toEqual([installed.files[0].path]);
   expect(await readFile(settings, "utf8")).toBe('model = "existing"\n');
   expect(await readFile(installed.files[0].path, "utf8")).toBe("user edited skill");
   expect((await uninstallAgentSkills(options)).removed).toEqual([]);
   expect((await previewAgentInstallation(options)).files[0].action).toBe("conflict");
  }
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent installation rejects unowned skills and symlink parents", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-agents-"));
 try {
  const options = { agent: "codex" as const, home: join(root, "home"), stateRoot: join(root, "state") };
  const path = join(options.home, ".agents", "skills", "manas-recall", "SKILL.md");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "existing");
  await expect(installAgentSkills(options)).rejects.toThrow("conflicts");
  expect(await readFile(path, "utf8")).toBe("existing");
  await rm(join(options.home, ".agents"), { recursive: true });
  await mkdir(join(root, "other"));
  await symlink(join(root, "other"), join(options.home, ".agents"));
  await expect(installAgentSkills(options)).rejects.toThrow("symbolic link");
 } finally { await rm(root, { recursive: true, force: true }); }
});
