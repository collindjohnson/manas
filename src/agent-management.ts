import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { acquireStoreOwnership } from "./brain/ownership";
import recall from "../skills/manas-recall/SKILL.md" with { type: "text" };
import capture from "../skills/manas-capture/SKILL.md" with { type: "text" };
import correct from "../skills/manas-correct/SKILL.md" with { type: "text" };
import answer from "../skills/manas-answer/SKILL.md" with { type: "text" };
import maintain from "../skills/manas-maintain/SKILL.md" with { type: "text" };

export type ManagedAgent = "codex" | "claude-code";
interface OwnedFile { path: string; content: string; hash: string; }
interface Receipt { version: 1; agent: ManagedAgent; home: string; files: OwnedFile[]; installed: string[]; state: "installing" | "installed" | "removed"; }
export interface AgentInstallationOptions { agent: ManagedAgent; home: string; stateRoot: string; }
const skills = { recall, capture, correct, answer, maintain };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function validateAgent(agent: string): asserts agent is ManagedAgent { if (agent !== "codex" && agent !== "claude-code") throw new Error("agent must be codex or claude-code"); }
async function assertSafeParents(path: string) {
 let parent = dirname(path);
 while (parent !== dirname(parent)) {
  try { if ((await lstat(parent)).isSymbolicLink() && !(["/var", "/tmp", "/etc"].includes(parent) && await realpath(parent) === `/private${parent}`)) throw new Error(`installation parent is a symbolic link: ${parent}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  parent = dirname(parent);
 }
}
async function contents(path: string): Promise<string | undefined> {
 await assertSafeParents(path);
 try { if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new Error(`installation target is not a regular file: ${path}`); return await readFile(path, "utf8"); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function atomic(path: string, text: string) {
 await assertSafeParents(path);
 await mkdir(dirname(path), { recursive: true, mode: 0o700 });
 const temporary = `${path}.stage-${randomUUID()}`;
 try { await writeFile(temporary, text, { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
 finally { await rm(temporary, { force: true }); }
}
function receiptPath(options: AgentInstallationOptions) { return join(options.stateRoot, "agent-integrations", hash(`${options.agent}:${resolve(options.home)}`) + ".json"); }
async function receipt(options: AgentInstallationOptions): Promise<Receipt | undefined> {
 const text = await contents(receiptPath(options));
 if (!text) return;
 const value = JSON.parse(text) as Receipt;
 if (value.version !== 1 || value.agent !== options.agent || value.home !== resolve(options.home) || !Array.isArray(value.files) || !Array.isArray(value.installed)) throw new Error("invalid agent installation receipt");
 const expected = plannedFiles(options);
 if (value.files.length !== expected.length || value.files.some((file, index) => file.path !== expected[index].path || file.hash !== hash(file.content))) throw new Error("invalid agent file ownership receipt");
 return value;
}
function plannedFiles(options: AgentInstallationOptions): OwnedFile[] {
 validateAgent(options.agent);
 const root = join(resolve(options.home), ...(options.agent === "codex" ? [".agents", "skills"] : [".claude", "skills"]));
 return Object.entries(skills).map(([name, content]) => ({ path: join(root, `manas-${name}`, "SKILL.md"), content, hash: hash(content) }));
}
export async function previewAgentInstallation(options: AgentInstallationOptions) {
 const previous = await receipt(options);
 return { agent: options.agent, files: await Promise.all(plannedFiles(options).map(async (file) => {
  const current = await contents(file.path);
  const owned = previous?.state !== "removed" && previous?.files.some((old) => old.path === file.path && old.hash === hash(current ?? ""));
  return { path: file.path, hash: file.hash, action: current === undefined ? "create" : owned ? current === file.content ? "unchanged" : "update" : "conflict" };
 })), verificationScope: "skills-only" };
}
export async function installAgentSkills(options: AgentInstallationOptions) {
 await assertSafeParents(join(options.stateRoot, "agent-integrations", ".manas-owner.sqlite"));
 const release = await acquireStoreOwnership(join(options.stateRoot, "agent-integrations"));
 try {
  const preview = await previewAgentInstallation(options);
  if (preview.files.some((file) => file.action === "conflict")) throw new Error("agent installation conflicts with files not owned by Manas; inspect agents preview");
  const previous = await receipt(options);
  const value: Receipt = { version: 1, agent: options.agent, home: resolve(options.home), files: plannedFiles(options), installed: previous?.state === "removed" ? [] : previous?.installed ?? [], state: "installing" };
  // Journal ownership before each write; a restart can recognize a completed write.
  await atomic(receiptPath(options), JSON.stringify(value));
  for (const file of value.files) {
   const current = await contents(file.path);
   const prior = previous?.files.find((old) => old.path === file.path);
   if (current !== undefined && hash(current) !== file.hash && (!prior || hash(current) !== prior.hash)) throw new Error("agent file changed during installation");
   await atomic(file.path, file.content);
   if (!value.installed.includes(file.path)) value.installed.push(file.path);
   await atomic(receiptPath(options), JSON.stringify(value));
  }
  value.state = "installed";
  await atomic(receiptPath(options), JSON.stringify(value));
  return agentInstallationStatus(options);
 } finally { release(); }
}
export async function agentInstallationStatus(options: AgentInstallationOptions) {
 const value = await receipt(options);
 const files = await Promise.all((value?.files ?? []).map(async (file) => ({ path: file.path, intact: hash(await contents(file.path) ?? "") === file.hash })));
 return { agent: options.agent, configurationInstalled: value?.state === "installed" && files.every((file) => file.intact), files, verificationScope: "skills-only", nextStep: "Inspect hook and MCP status separately; skill installation does not verify a native session." };
}
export async function uninstallAgentSkills(options: AgentInstallationOptions) {
 await assertSafeParents(join(options.stateRoot, "agent-integrations", ".manas-owner.sqlite"));
 const release = await acquireStoreOwnership(join(options.stateRoot, "agent-integrations"));
 try {
  const value = await receipt(options), removed: string[] = [], preserved: string[] = [];
  if (!value || value.state === "removed") return { removed, preserved };
  for (const file of value.files) {
   const current = await contents(file.path);
   if (current === undefined) continue;
   if (hash(current) !== file.hash) { preserved.push(file.path); continue; }
   await rm(file.path); removed.push(file.path);
  }
  value.state = "removed";
  await atomic(receiptPath(options), JSON.stringify(value));
  return { removed, preserved };
 } finally { release(); }
}

export { contents as readManagedFile, atomic as writeManagedFile, assertSafeParents as assertManagedParents };
