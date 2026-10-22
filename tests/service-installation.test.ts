import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installService, previewServiceInstallation, previewServiceRemoval, renderServiceLaunchAgent, serviceInstallationStatus, uninstallService, type LaunchctlRunner } from "../src/service-installation";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "manas-service-install-")); roots.push(root);
  const config = { archiveRoot: join(root, "archive"), stateRoot: join(root, "state"), launchAgentPath: join(root, "agents", "legacy.plist") };
  const target = { installedBinary: join(root, "manas"), configPath: join(root, "config.json"), repositoryRoot: join(root, "brain") };
  await writeFile(target.installedBinary, "#!/bin/sh\nexit 0\n"); await chmod(target.installedBinary, 0o700);
  await writeFile(target.configPath, "{}"); await mkdir(target.repositoryRoot);
  let loaded = false; const calls: string[][] = [];
  const runner: LaunchctlRunner = async (args) => {
    calls.push(args);
    if (args[0] === "print") return { exitCode: loaded ? 0 : 113, stdout: "", stderr: "" };
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { root, config, target, runner, calls };
}
describe("canonical macOS service installation", () => {
  test("previews without creating files and renders persistent escaped arguments", async () => {
    const { config, target } = await fixture();
    const preview = await previewServiceInstallation(config, { ...target, repositoryRoot: target.repositoryRoot + "&<" });
    expect(preview.installed).toBe(false);
    expect(preview.plist).toContain("<string>service</string><string>start</string>");
    expect(preview.plist).toContain("&amp;&lt;");
    expect(preview.plist).toContain("<key>RunAtLoad</key><true/>");
    expect(preview.plist).toContain("<key>KeepAlive</key><true/>");
    expect(preview.plist).not.toContain("StartCalendarInterval");
    expect(() => renderServiceLaunchAgent(config, { ...target, configPath: "relative" })).toThrow("absolute");
  });
  test("installs, resumes an already installed service, and removes only owned files", async () => {
    const { config, target, runner, calls } = await fixture();
    const installed = await installService(config, target, runner);
    expect(installed).toMatchObject({ installed: true, owned: true, loaded: true });
    await installService(config, target, runner);
    expect(calls.filter((call) => call[0] === "bootstrap")).toHaveLength(1);
    expect(await serviceInstallationStatus(config, runner)).toMatchObject({ loaded: true, owned: true });
    expect(await uninstallService(config, runner)).toMatchObject({ removed: true, preserved: false });
    expect(await previewServiceInstallation(config, target)).toMatchObject({ installed: false, conflict: false });
  });
  test("preserves edited and unrelated plists without unloading them", async () => {
    const { config, target, runner, calls } = await fixture();
    const installed = await installService(config, target, runner);
    await writeFile(installed.path, "user edit");
    calls.length = 0;
    expect(await uninstallService(config, runner)).toMatchObject({ removed: false, preserved: true });
    expect(calls).toHaveLength(0);
    await expect(installService(config, target, runner)).rejects.toThrow("not owned");
    expect(await readFile(installed.path, "utf8")).toBe("user edit");
  });
  test("refuses a loaded unowned label before writing an installation", async () => {
    const { config, target } = await fixture();
    const runner: LaunchctlRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    await expect(installService(config, target, runner)).rejects.toThrow("unowned service");
    expect(await previewServiceRemoval(config)).toMatchObject({ installed: false, wouldRemove: false });
  });
  test("previews removal and preserves edits made while unloading", async () => {
    const { config, target, runner } = await fixture();
    const installed = await installService(config, target, runner);
    expect(await previewServiceRemoval(config)).toMatchObject({ wouldRemove: true, wouldPreserve: false });
    const editing: LaunchctlRunner = async (args) => {
      const result = await runner(args);
      if (args[0] === "bootout") await writeFile(installed.path, "edited during unload");
      return result;
    };
    expect(await uninstallService(config, editing)).toMatchObject({ removed: false, preserved: true });
    expect(await readFile(installed.path, "utf8")).toBe("edited during unload");
  });
  test("keeps a reviewable installation when launchctl activation fails", async () => {
    const { config, target } = await fixture();
    const runner: LaunchctlRunner = async () => ({ exitCode: 1, stdout: "", stderr: "private details" });
    const result = await installService(config, target, runner);
    expect(result).toMatchObject({ installed: true, owned: true, loaded: false });
    expect(result).toHaveProperty("activationError");
    expect(JSON.stringify(result)).not.toContain("private details");
  });
  test("does not remove files if launchctl cannot stop the service", async () => {
    const { config, target, runner } = await fixture();
    const installed = await installService(config, target, runner);
    const failing: LaunchctlRunner = async (args) => args[0] === "bootout" ? { exitCode: 1, stdout: "", stderr: "" } : runner(args);
    await expect(uninstallService(config, failing)).rejects.toThrow("could not unload");
    expect(await readFile(installed.path, "utf8")).toContain("KeepAlive");
  });
  test("preserves edits made while unloading for an update", async () => {
    const { config, target, runner } = await fixture();
    const installed = await installService(config, target, runner);
    const editing: LaunchctlRunner = async (args) => {
      const result = await runner(args);
      if (args[0] === "bootout") await writeFile(installed.path, "edited during update");
      return result;
    };
    await expect(installService(config, { ...target, storePath: join(config.stateRoot, "new-store") }, editing)).rejects.toThrow("changed during unload");
    expect(await readFile(installed.path, "utf8")).toBe("edited during update");
  });
  test("updates owned arguments by unloading and bootstrapping the service", async () => {
    const { config, target, runner, calls } = await fixture();
    const installed = await installService(config, target, runner);
    const changed = { ...target, storePath: join(config.stateRoot, "different-runtime") };
    expect(await installService(config, changed, runner)).toMatchObject({ owned: true, loaded: true });
    expect(calls.filter((call) => call[0] === "bootout")).toHaveLength(1);
    expect(calls.filter((call) => call[0] === "bootstrap")).toHaveLength(2);
    expect(await readFile(installed.path, "utf8")).toContain(changed.storePath);
  });
});
