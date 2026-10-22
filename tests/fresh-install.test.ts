import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrainRepository } from "../src/brain/repository";
import { createFullOperationRegistry } from "../src/brain/operation-catalog";

test("a fresh runtime reads, captures and reopens without owner Git identity or configuration changes", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-fresh-install-"));
 try {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" });
  const program = `
   import { createBrainEngine } from ${JSON.stringify(new URL("../src/engine.ts", import.meta.url).href)};
   import { defaultConfig } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
   import { writeFile, readFile } from "node:fs/promises";
   import { execFileSync } from "node:child_process";
   import { join } from "node:path";
   const root = ${JSON.stringify(root)};
   const options = { repositoryRoot: join(root,"brain"), storePath: join(root,"state"), config: defaultConfig({}) };
   const owner = { scope: "admin", tenantId: "local", principal: "owner" };
   let engine = await createBrainEngine(options);
   try {
    const initial = await engine.repository.snapshot();
    if (initial.pages.length) throw new Error("fresh brain is not empty");
    const empty = await engine.operations.execute(owner,"retrieval.search",{query:"Juniper",options:{mode:"keyword"}});
    if (empty.results.length) throw new Error("empty search returned content");
    await writeFile(join(options.repositoryRoot,"unowned.txt"),"preserve me");
    await engine.operations.execute(owner,"memory.remember",{text:"Juniper owner is Maya.",idempotencyKey:"first",provenance:{sourceType:"user"}});
    const git = (...args) => execFileSync("git",["-C",options.repositoryRoot,...args],{encoding:"utf8"}).trim();
    const actor = git("log","-1","--format=%an <%ae>");
    if (actor !== "Manas <manas@localhost>") throw new Error("fallback actor is missing");
    if (git("config","--local","--list").includes("user.")) throw new Error("Git identity configuration changed");
    git("config","user.name","Explicit Owner"); git("config","user.email","owner@example.invalid");
    await engine.operations.execute(owner,"memory.remember",{text:"Another assertion.",idempotencyKey:"second",provenance:{sourceType:"user"}});
    if (git("log","-1","--format=%an <%ae>") !== "Explicit Owner <owner@example.invalid>") throw new Error("configured identity was replaced");
    const head = await engine.repository.head();
    await engine.close(); engine = await createBrainEngine(options);
    if (await engine.repository.head() !== head) throw new Error("reopen created another initialization commit");
    const recall = await engine.operations.execute(owner,"memory.recall",{query:"Juniper"});
    if (recall.results.length !== 1) throw new Error("capture did not survive restart");
    if (await readFile(join(options.repositoryRoot,"unowned.txt"),"utf8") !== "preserve me" || git("ls-files","unowned.txt")) throw new Error("user file was adopted or modified");
    console.log(JSON.stringify({initialPages:initial.pages.length,emptySearch:empty.results.length,recalled:recall.results.length,actor}));
   } finally { await engine.close(); }
  `;
  const child = Bun.spawn([process.execPath, "-e", program], { env, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(JSON.parse(output)).toEqual({ initialPages: 0, emptySearch: 0, recalled: 1, actor: "Manas <manas@localhost>" });
 } finally { await rm(root, { recursive: true, force: true }); }
}, 20000);

test("runtime initialization is idempotent and does not adopt an interrupted import", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-init-operation-"));
 try {
  const repository = new BrainRepository(join(root, "brain"));
  const registry = createFullOperationRegistry({ repository });
  const owner = { scope: "admin" as const, tenantId: "local" };
  expect(await registry.execute(owner, "runtime.init", {})).toMatchObject({ initialized: true });
  const head = await repository.head();
  await registry.execute(owner, "runtime.init", {});
  expect(await repository.head()).toBe(head);
  const unfinished = new BrainRepository(join(root, "unfinished"));
  await unfinished.initialize();
  await Bun.write(join(unfinished.root, ".brain", "manifest.jsonl"), JSON.stringify({ id: "old", path: "old.md", contentHash: "a".repeat(64), revision: "a".repeat(64) }) + "\n");
  await expect(unfinished.ensureInitialCommit()).rejects.toMatchObject({ code: "brain_initialization_incomplete" });
  expect(await unfinished.head()).toBeUndefined();
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("initializing below an existing checkout creates an independent brain repository", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-nested-brain-"));
 try {
  const { execFileSync } = await import("node:child_process");
  const { realpath } = await import("node:fs/promises");
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  await Bun.write(join(root, "user-note.txt"), "existing project work");
  const repository = new BrainRepository(join(root, "brain"));
  await repository.initialize();
  await repository.ensureInitialCommit();
  const top = execFileSync("git", ["-C", repository.root, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  expect(await realpath(top)).toBe(await realpath(repository.root));
  expect((await repository.snapshot()).pages).toEqual([]);
  expect(execFileSync("git", ["-C", repository.root, "ls-files"], { encoding: "utf8" })).not.toContain("user-note.txt");
  expect(await Bun.file(join(root, "user-note.txt")).text()).toBe("existing project work");
 } finally { await rm(root, { recursive: true, force: true }); }
});
