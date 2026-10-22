import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { createBrainEngine } from "../src/engine";
import { callLocalService } from "../src/local-service";
import { installService, uninstallService } from "../src/service-installation";

if (!process.argv.includes("--run-native") || process.platform !== "darwin") throw new Error("Usage on macOS: bun run scripts/verify-native-service.ts --run-native [--report path]");
const run = promisify(execFile);
const label = "com.collindjohnson.manas.service", domain = "gui/" + process.getuid!();
async function loaded() {
 try { return (await run("/bin/launchctl", ["print", domain + "/" + label])).stdout; }
 catch (error) { if ((error as { code?: unknown }).code === 113) return undefined; throw error; }
}
async function waitUnloaded() {
 for (let attempt = 0; attempt < 120; attempt++) {
  if (!await loaded()) return true;
  await new Promise((done) => setTimeout(done, 250));
 }
 return false;
}
if (await loaded()) throw new Error("An existing Manas service is loaded; leave it untouched and run this smoke check in a separate macOS user session.");
const root = await mkdtemp(join(tmpdir(), "manas-native-service-"));
const config = { ...defaultConfig({}), stateRoot: join(root, "state"), archiveRoot: join(root, "archive"), launchAgentPath: join(root, "LaunchAgents", "legacy.plist") };
const configPath = join(root, "config.json"), repositoryRoot = join(root, "brain"), storePath = join(root, "store");
await mkdir(config.stateRoot); await writeFile(configPath, JSON.stringify(config));
let installationAttempted = false, cleaned = false;
const checks: Record<string, unknown>[] = [];
async function health() {
 const started = performance.now();
 for (let attempt = 0; attempt < 120; attempt++) {
  try { await callLocalService(config, "service.status", {}, { timeoutMs: 500 }); return Math.round(performance.now() - started); }
  catch { await new Promise((done) => setTimeout(done, 250)); }
 }
 throw new Error("Native launchd service did not become healthy within 30 seconds.");
}
try {
 const engine = await createBrainEngine({ config, repositoryRoot, storePath });
 try {
  await run("git", ["-C", repositoryRoot, "config", "user.name", "Native service fixture"]);
  await run("git", ["-C", repositoryRoot, "config", "user.email", "fixture@example.invalid"]);
 } finally { await engine.close(); }
 installationAttempted = true;
 const installed = await installService(config, { installedBinary: resolve("dist/manas-darwin-" + process.arch), configPath, repositoryRoot, storePath });
 if (!installed.loaded || installed.activationError) throw new Error("Native launchd bootstrap failed.");
 checks.push({ name: "launchd-bootstrap-and-health", passed: true, latencyMs: await health() });
 const text = "The native service fixture owner is Juniper.";
 const memory = await callLocalService(config, "memory.remember", { text, provenance: { sourceType: "synthetic-native-fixture" }, idempotencyKey: "native-service-seed" }) as { id: string };
 const before = await loaded(), pid = Number(before?.match(/\bpid = (\d+)/)?.[1]);
 if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Cannot identify the owned launchd process.");
 process.kill(pid, "SIGKILL");
 const recoveryStarted = performance.now();
 let replacement = 0;
 for (let attempt = 0; attempt < 120; attempt++) {
  replacement = Number((await loaded())?.match(/\bpid = (\d+)/)?.[1]);
  if (replacement > 1 && replacement !== pid) break;
  await new Promise((done) => setTimeout(done, 250));
 }
 if (!(replacement > 1 && replacement !== pid)) throw new Error("launchd did not restart the owned process.");
 await health();
 const result = await callLocalService(config, "memory.recall", { query: "Juniper" }) as { results: Array<{ id: string; text: string }> };
 const recovered = result.results.some((record) => record.id === memory.id && record.text === text);
 checks.push({ name: "crash-restart-and-durable-recall", passed: recovered, latencyMs: Math.round(performance.now() - recoveryStarted) });
 if (!recovered) throw new Error("Restart did not retain canonical memory.");
 const removed = await uninstallService(config);
 cleaned = removed.removed && await waitUnloaded();
 checks.push({ name: "owned-uninstall", passed: cleaned });
 if (!cleaned) throw new Error("Native service cleanup did not complete.");
 const report = { version: 1, createdAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, isolated: true, persistentUserConfigurationChanged: false, checks, passed: true, limitations: "Temporarily bootstraps the production label from a disposable plist only when no existing service is loaded. Verifies real launchd startup, crash recovery, durable recall, and removal. Does not exercise logout/login, machine sleep, or visible notification delivery." };
 const index = process.argv.indexOf("--report");
 if (index >= 0) { if (!process.argv[index + 1]) throw new Error("--report requires a path"); await writeFile(resolve(process.argv[index + 1]), JSON.stringify(report, null, 2) + "\n"); }
 console.log(JSON.stringify(report, null, 2));
} finally {
 if (installationAttempted && !cleaned) { await uninstallService(config); cleaned = await waitUnloaded(); }
 if (!installationAttempted || cleaned) await rm(root, { recursive: true, force: true });
 else console.error("Preserved native service fixture for recovery: " + root);
}
