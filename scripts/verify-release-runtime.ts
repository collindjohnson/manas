import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
const index = process.argv.indexOf("--target");
const selected = index >= 0 ? process.argv[index + 1] : undefined;
const requireTarget = process.argv.includes("--require-target");
if ((index >= 0 && !["darwin-arm64", "darwin-x64"].includes(selected ?? "")) || requireTarget && !selected) throw new Error("Usage: bun run scripts/verify-release-runtime.ts [--target darwin-arm64|darwin-x64] [--require-target]");
const root = await mkdtemp(join(tmpdir(), "manas-release-smoke-"));
const reports = [];
async function run(binary: string, args: string[]) {
 const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
 const timer = setTimeout(() => child.kill(), 30000);
 try {
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(basename(binary) + " failed: " + error + out);
  return out;
 } finally { clearTimeout(timer); }
}
try {
 for (const target of selected ? [selected] : ["darwin-arm64", "darwin-x64"]) {
  const binary = resolve("dist/manas-" + target), config = join(root, target + ".json"), repo = join(root, target, "brain"), state = join(root, target, "store");
  await Bun.write(config, JSON.stringify({ stateRoot: join(root, target, "state"), providers: {} }));
  let version: string;
  try { version = (await run(binary, ["--version"])).trim(); }
  catch (error) {
   if ((error as { code?: string }).code === "EBADARCH" && !requireTarget) { reports.push({ target, execution: "unavailable", reason: "EBADARCH: this host cannot execute the " + target + " binary" }); continue; }
   throw error;
  }
  const args = ["--config", config];
  const first = JSON.parse(await run(binary, [...args, "remember", "--repo", repo, "--store", state, "--input", JSON.stringify({ text: "Juniper owner is Maya.", idempotencyKey: "release-smoke", provenance: { sourceType: "evaluation" } })]));
  const recalled = JSON.parse(await run(binary, [...args, "recall", "--repo", repo, "--store", state, "--input", JSON.stringify({ query: "Juniper" })]));
  if (!first.data.id || recalled.data.results.length !== 1 || recalled.data.results[0].id !== first.data.id || recalled.data.results[0].text !== "Juniper owner is Maya.") throw new Error("Compiled memory lifecycle did not persist");
  reports.push({ target, version, remembered: true, recalledAfterProcessRestart: recalled.data.results.length });
 }
 console.log(JSON.stringify({ createdAt: new Date().toISOString(), isolated: true, requiredTarget: requireTarget ? selected : null, checks: reports }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
