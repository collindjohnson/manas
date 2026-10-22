import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyArchiveMigration, previewArchiveMigration } from "../src/archive-migration";
import { BrainRepository } from "../src/brain/repository";
import { migrateLegacyArchive } from "../src/migration";

test("legacy migration imports into an empty initialized runtime and resumes through its durable receipt", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-migration-bootstrap-"));
 try {
  const repository = new BrainRepository(join(root, "brain"));
  await repository.initialize(); await repository.ensureInitialCommit();
  const initial = await repository.head();
  const source = join(root, "archive"), stateRoot = join(root, "state");
  const content = "---\nmanas_id: stable-import\n---\nUser edits and transcript.\n";
  await Bun.write(join(source, "chat.md"), content);
  const imported = await migrateLegacyArchive(source, repository, { stateRoot });
  expect(imported).toMatchObject({ copied: 1, documents: 1 });
  expect(imported.commit).not.toBe(initial);
  expect(await migrateLegacyArchive(source, repository, { stateRoot, receiptId: imported.migrationId })).toEqual(imported);
  expect((await repository.snapshot()).pages).toMatchObject([{ id: "stable-import", source: { provenance: { metadata: { migrationId: imported.migrationId } } } }]);
  expect(await readFile(join(source, "chat.md"), "utf8")).toBe(content);
  const otherSource = join(root, "other"); await Bun.write(join(otherSource, "different.md"), "different");
  await expect(migrateLegacyArchive(otherSource, repository, { stateRoot })).rejects.toThrow("existing knowledge");
  expect(await repository.head()).toBe(imported.commit);
  expect(await Bun.file(join(repository.root, "different.md")).exists()).toBe(false);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("migration and ordinary writes share a fence even when the diagnostic file lease expires", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-migration-fence-"));
 let release!: () => void;
 let running: Promise<unknown> | undefined;
 try {
  const source = join(root, "archive"), target = join(root, "brain"), state = join(root, "state");
  await Bun.write(join(source, "import.md"), "Import source.");
  const plan = await previewArchiveMigration(source, target, state);
  const other = join(root, "other"); await Bun.write(join(other, "other.md"), "Other import.");
  const otherState = join(root, "other-state");
  const competing = await previewArchiveMigration(other, target, otherState);
  let entered!: () => void;
  const ready = new Promise<void>((done) => { entered = done; }), gate = new Promise<void>((done) => { release = done; });
  running = applyArchiveMigration(state, plan.id, { fault: async (point) => { if (point === "copied") { entered(); await gate; } } });
  await ready;
  const leasePath = join(target, ".brain", "mutation.lock"), lease = JSON.parse(await readFile(leasePath, "utf8"));
  await writeFile(leasePath, JSON.stringify({ ...lease, expiresAt: Date.now() - 1 }));
  let wrote = false;
  const writer = new BrainRepository(target).putPage("notes/new.md", "Concurrent owner note.").then(() => { wrote = true; });
  const competitor = applyArchiveMigration(otherState, competing.id).then(() => ({ succeeded: true }), (error) => ({ succeeded: false, error }));
  await new Promise((done) => setTimeout(done, 75));
  expect(wrote).toBe(false);
  expect(await Bun.file(join(target, "other.md")).exists()).toBe(false);
  release(); await running; await writer;
  expect(await competitor).toMatchObject({ succeeded: false });
  expect((await new BrainRepository(target).snapshot()).pages.map((page) => page.path).sort()).toEqual(["import.md", "notes/new.md"]);
 } finally { release?.(); await running?.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test("a killed Git writer releases its kernel fence and a successor reclaims the stale process receipt", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-git-crash-"));
 let child: ReturnType<typeof Bun.spawn> | undefined;
 try {
  const repository = new BrainRepository(join(root, "brain"));
  await repository.initialize();
  const program = `import {BrainRepository} from ${JSON.stringify(new URL("../src/brain/repository.ts", import.meta.url).href)}; const repository=new BrainRepository(${JSON.stringify(repository.root)}); await repository.withExclusiveMutation(async()=>{console.log("locked");await new Promise(()=>setInterval(()=>{},1000));});`;
  child = Bun.spawn([process.execPath, "-e", program], { stdout: "pipe", stderr: "pipe" });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const message = await reader.read();
  expect(new TextDecoder().decode(message.value)).toContain("locked");
  await reader.cancel(); child.kill("SIGKILL"); await child.exited;
  expect(JSON.parse(await readFile(join(repository.root, ".brain", "mutation.lock"), "utf8")).expiresAt).toBeGreaterThan(Date.now());
  await repository.putPage("notes/recovered.md", "Recovered after process death.");
  expect((await repository.snapshot()).pages).toHaveLength(1);
 } finally { child?.kill(); await rm(root, { recursive: true, force: true }); }
});

test("migration previews reject operational state inside source or target without polluting either", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-migration-boundaries-"));
 try {
  const source = join(root, "archive"); await Bun.write(join(source, "note.md"), "note");
  await expect(previewArchiveMigration(source, join(root, "brain"), join(source, "state"))).rejects.toThrow("must be separate");
  expect(await Bun.file(join(source, "state")).exists()).toBe(false);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("offline migration cannot run while the configured runtime owns its service state", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-migration-offline-"));
 const { acquireStoreOwnership } = await import("../src/brain/ownership");
 try {
  const source = join(root, "archive"), target = join(root, "brain"), state = join(root, "state");
  await Bun.write(join(source, "note.md"), "note");
  const receipt = await previewArchiveMigration(source, target, state);
  const release = await acquireStoreOwnership(join(state, "service"));
  try { await expect(applyArchiveMigration(state, receipt.id)).rejects.toMatchObject({ code: "store_owned", retryable: true }); }
  finally { release(); }
  expect(await Bun.file(join(target, "note.md")).exists()).toBe(false);
  expect((await applyArchiveMigration(state, receipt.id)).status).toBe("verified");
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy CLI migration uses configured receipts, preserves its output, and resumes explicitly", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-migration-cli-"));
 try {
  const config = join(root, "config.json"), source = join(root, "archive"), target = join(root, "brain"), stateRoot = join(root, "state");
  await Bun.write(config, JSON.stringify({ stateRoot }));
  await Bun.write(join(source, "chat.md"), "---\nmanas_id: cli-migration\n---\nLegacy edited transcript.");
  const cli = async (...args: string[]) => {
   const child = Bun.spawn([process.execPath, "src/cli.ts", "--config", config, "brain", ...args, "--repo", target], { stdout: "pipe", stderr: "pipe" });
   const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
   expect({ code, error, failure: code ? output : "" }).toEqual({ code: 0, error: "", failure: "" }); return JSON.parse(output).data;
  };
  await cli("init");
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", target, "config", "user.name", "Migration Owner"]);
  execFileSync("git", ["-C", target, "config", "user.email", "migration@example.invalid"]);
  const first = await cli("migrate", "--from", source);
  expect(first).toMatchObject({ copied: 1, documents: 1 });
  expect(first.commit).toBeString(); expect(first.migrationId).toBeString();
  expect(execFileSync("git", ["-C", target, "log", "-1", "--format=%an <%ae>"], { encoding: "utf8" }).trim()).toBe("Migration Owner <migration@example.invalid>");
  expect(await cli("migrate", "--from", source, "--id", first.migrationId)).toEqual(first);
  const receipt = JSON.parse(await readFile(join(stateRoot, "archive-migrations", first.migrationId, "receipt.json"), "utf8"));
  expect(receipt).toMatchObject({ status: "verified", id: first.migrationId });
  expect((await new BrainRepository(target).snapshot()).pages[0]?.id).toBe("cli-migration");
 } finally { await rm(root, { recursive: true, force: true }); }
});
