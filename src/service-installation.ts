import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./config";
import { acquireStoreOwnership } from "./brain/ownership";

const label = "com.collindjohnson.manas.service";
export interface ServiceInstallation {
  installedBinary: string;
  configPath: string;
  repositoryRoot: string;
  storePath?: string;
}
export interface LaunchctlResult { exitCode: number; stdout: string; stderr: string }
export type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;
const runLaunchctl: LaunchctlRunner = async (args) => {
  if (process.platform !== "darwin") throw new Error("service installation requires macOS");
  const child = Bun.spawn(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
};
function absolute(value: string, name: string): string {
  if (!value.startsWith("/") || /[\u0000-\u001f]/u.test(value)) throw new Error(name + " must be an absolute path without control characters");
  return resolve(value);
}
function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function paths(config: Config) {
  return { plist: join(dirname(config.launchAgentPath), label + ".plist"), receipt: join(config.stateRoot, "service-installation.json"), lock: join(config.stateRoot, "service-installation-lock") };
}
function domain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("service installation requires a macOS user session");
  return "gui/" + uid;
}
export function renderServiceLaunchAgent(config: Config, target: ServiceInstallation): string {
  const args = [absolute(target.installedBinary, "binary"), "service", "start", "--config", absolute(target.configPath, "configuration"), "--repo", absolute(target.repositoryRoot, "repository"), "--store", absolute(target.storePath ?? join(config.stateRoot, "runtime"), "store")];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n'
    + "<key>Label</key><string>" + label + "</string>\n<key>ProgramArguments</key><array>" + args.map((arg) => "<string>" + xml(arg) + "</string>").join("") + "</array>\n"
    + "<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>ProcessType</key><string>Background</string>\n"
    + "<key>StandardOutPath</key><string>" + xml(resolve(config.stateRoot, "service.log")) + "</string>\n<key>StandardErrorPath</key><string>" + xml(resolve(config.stateRoot, "service.err.log")) + "</string>\n</dict></plist>\n";
}
async function regularText(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("service installation file must be a bounded regular file: " + path);
    return await readFile(path, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
interface Receipt { version: 1; label: string; plistPath: string; sha256: string }
async function inspect(config: Config) {
  const locations = paths(config);
  const [plist, raw] = await Promise.all([regularText(locations.plist), regularText(locations.receipt)]);
  let receipt: Receipt | undefined;
  if (raw !== undefined) {
    try { receipt = JSON.parse(raw); } catch { throw new Error("service ownership receipt is invalid"); }
    if (!receipt || receipt.version !== 1 || receipt.label !== label || receipt.plistPath !== locations.plist || !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw new Error("service ownership receipt is invalid");
  }
  return { ...locations, plistText: plist, owned: plist !== undefined && receipt !== undefined && hash(plist) === receipt.sha256 };
}
export async function previewServiceInstallation(config: Config, target: ServiceInstallation) {
  const state = await inspect(config);
  const plist = renderServiceLaunchAgent(config, target);
  return { path: state.plist, installed: state.plistText !== undefined, owned: state.owned, installedSha256: state.plistText === undefined ? undefined : hash(state.plistText), conflict: state.plistText !== undefined && !state.owned, changed: state.plistText !== plist, plist };
}
export async function serviceInstallationStatus(config: Config, runner: LaunchctlRunner = runLaunchctl) {
  const state = await inspect(config);
  const loaded = await runner(["print", domain() + "/" + label]);
  return { path: state.plist, installed: state.plistText !== undefined, owned: state.owned, loaded: loaded.exitCode === 0 };
}
export async function installService(config: Config, target: ServiceInstallation, runner: LaunchctlRunner = runLaunchctl) {
  if (runner === runLaunchctl && process.platform !== "darwin") throw new Error("service installation requires macOS");
  const release = await acquireStoreOwnership(paths(config).lock);
  try {
    const preview = await previewServiceInstallation(config, target);
    if (preview.conflict) throw new Error("service plist is not owned or has been edited; preserve it and resolve the conflict before installation");
    if (!preview.installed && (await runner(["print", domain() + "/" + label])).exitCode === 0) throw new Error("an unowned service is already loaded; installation was preserved");
    for (const [path, executable] of [[target.installedBinary, true], [target.configPath, false]] as const) {
      const stat = await lstat(absolute(path, executable ? "binary" : "configuration"));
      if (!stat.isFile() || stat.isSymbolicLink() || executable && (stat.mode & 0o111) === 0) throw new Error("service target must be a regular " + (executable ? "executable" : "configuration file"));
    }
    const repo = await lstat(absolute(target.repositoryRoot, "repository"));
    if (!repo.isDirectory() || repo.isSymbolicLink()) throw new Error("service repository must be a regular directory");
    await mkdir(config.stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(dirname(preview.path), { recursive: true });
    if (preview.installed && preview.changed) {
      const stopped = await runner(["bootout", domain() + "/" + label]);
      if (stopped.exitCode !== 0 && (await runner(["print", domain() + "/" + label])).exitCode === 0) throw new Error("could not unload the existing service; installation was preserved");
    }
    if (preview.changed) {
      // Exclusive creation protects unrelated files. Updates are serialized and require the recorded hash.
      if (preview.installed) {
        const current = await inspect(config);
        if (!current.owned || hash(current.plistText!) !== preview.installedSha256) throw new Error("service plist changed during unload; edited files were preserved");
        const temporary = preview.path + "." + crypto.randomUUID() + ".tmp";
        await writeFile(temporary, preview.plist, { mode: 0o600, flag: "wx" });
        try { await rename(temporary, preview.path); } finally { await unlink(temporary).catch(() => {}); }
      } else await writeFile(preview.path, preview.plist, { mode: 0o600, flag: "wx" });
      await chmod(preview.path, 0o600);
    }
    const receipt: Receipt = { version: 1, label, plistPath: preview.path, sha256: hash(preview.plist) };
    const temporary = paths(config).receipt + "." + crypto.randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(receipt) + "\n", { mode: 0o600, flag: "wx" });
    try { await rename(temporary, paths(config).receipt); } finally { await unlink(temporary).catch(() => {}); }
    if ((await runner(["print", domain() + "/" + label])).exitCode !== 0) {
      const started = await runner(["bootstrap", domain(), preview.path]);
      if (started.exitCode !== 0) return { ...await serviceInstallationStatus(config, runner), activationError: "launchctl bootstrap failed; inspect launchctl and the service logs, then retry installation" };
    }
    return await serviceInstallationStatus(config, runner);
  } finally { release(); }
}
export async function previewServiceRemoval(config: Config) {
  const state = await inspect(config);
  return { path: state.plist, installed: state.plistText !== undefined, owned: state.owned, wouldRemove: state.owned, wouldPreserve: state.plistText !== undefined && !state.owned };
}
export async function uninstallService(config: Config, runner: LaunchctlRunner = runLaunchctl) {
  if (runner === runLaunchctl && process.platform !== "darwin") throw new Error("service installation requires macOS");
  const release = await acquireStoreOwnership(paths(config).lock);
  try {
    const state = await inspect(config);
    if (state.plistText !== undefined && !state.owned) return { removed: false, preserved: true, path: state.plist };
    const loaded = await runner(["print", domain() + "/" + label]);
    if (loaded.exitCode === 0) {
      if (!state.owned) return { removed: false, preserved: true, path: state.plist };
      const stopped = await runner(["bootout", domain() + "/" + label]);
      if (stopped.exitCode !== 0) throw new Error("could not unload service; installed files were preserved");
    }
    // Recheck ownership after the external command before removing anything.
    const current = await inspect(config);
    if (current.plistText !== undefined && !current.owned) return { removed: false, preserved: true, path: current.plist };
    if (current.owned) await unlink(current.plist);
    await unlink(current.receipt).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    return { removed: current.owned, preserved: false, path: current.plist };
  } finally { release(); }
}
