import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { buildConversation } from "../src/adapters/common";
import { defaultConfig } from "../src/config";
import { runSync } from "../src/sync";
import { verifyArchive } from "../src/report";
import { renderLaunchAgent, validateLaunchAgent } from "../src/launch-agent";
import { withStateLock } from "../src/state";
import type { Config } from "../src/config";

async function configDir(): Promise<Config> {
  const root = await mkdtemp(join(tmpdir(), "manas-system-"));
  return { archiveRoot: join(root, "archive"), stateRoot: join(root, "state"), launchAgentPath: join(root, "agent.plist") };
}

describe("sync system", () => {
  test("defaults to the Manas archive and preserves archive overrides", () => {
    const previous = process.env.MANAS_ARCHIVE;
    try {
      delete process.env.MANAS_ARCHIVE;
      expect(defaultConfig().archiveRoot).toBe(join(homedir(), ".local/share/manas/archive"));
      process.env.MANAS_ARCHIVE = "/tmp/custom-chat-history";
      expect(defaultConfig().archiveRoot).toBe("/tmp/custom-chat-history");
    } finally {
      if (previous === undefined) delete process.env.MANAS_ARCHIVE;
      else process.env.MANAS_ARCHIVE = previous;
    }
  });

  test("writes indexes, report, state, and verifies generated archive", async () => {
    const config = await configDir();
    await mkdir(config.archiveRoot, { recursive: true });
    await chmod(config.archiveRoot, 0o755);
    const conversation = buildConversation("grok", "grok-1", "/tmp/grok", {}, [{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello" }], "Grok");
    const result = await runSync(config, { conversations: [conversation!] });
    expect(result.report.totals.created).toBe(1);
    expect(await readFile(join(config.archiveRoot, "SYNC_REPORT.md"), "utf8")).toContain("date");
    expect(await readFile(join(config.archiveRoot, "grok", "INDEX.md"), "utf8")).toContain("Grok");
    expect((await stat(config.archiveRoot)).mode & 0o777).toBe(0o700);
    const verification = await verifyArchive(config.archiveRoot);
    expect(verification.ok).toBe(true);
    expect(verification.documents).toBe(1);
    expect((await stat(join(config.stateRoot, "state.json"))).mode & 0o777).toBe(0o600);
  });

  test("dry-run does not create archive or state directories", async () => {
    const config = await configDir();
    const conversation = buildConversation("codex", "preview-only", join(tmpdir(), "codex"), {}, [{ role: "user", text: "Preview" }], "Preview");
    const result = await runSync(config, { conversations: [conversation!], dryRun: true });
    expect(result.report.totals.created).toBe(1);
    await expect(stat(config.archiveRoot)).rejects.toThrow();
    await expect(stat(config.stateRoot)).rejects.toThrow();
  });

  test("ignores hidden vault metadata during scanning and verification", async () => {
    const config = await configDir();
    const conversation = buildConversation("grok", "grok-hidden-test", "/tmp/grok", {}, [{ role: "user", text: "Hi" }], "Grok");
    await runSync(config, { conversations: [conversation!] });
    const obsidian = join(config.archiveRoot, ".obsidian");
    const hidden = join(config.archiveRoot, ".hidden-vault");
    await mkdir(obsidian, { recursive: true });
    await mkdir(hidden, { recursive: true });
    await Bun.write(join(obsidian, "workspace.json"), "not archive markdown");
    await Bun.write(join(hidden, "credentials.md"), "not valid archive frontmatter\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456");
    const verification = await verifyArchive(config.archiveRoot);
    expect(verification.ok).toBe(true);
    expect(verification.documents).toBe(1);
    expect(verification.errors).toEqual([]);
  });

  test("reports malformed percent-encoded index links without crashing", async () => {
    const config = await configDir();
    const conversation = buildConversation("grok", "grok-malformed-link", join(tmpdir(), "grok"), {}, [{ role: "user", text: "Hi" }], "Grok");
    await runSync(config, { conversations: [conversation!] });
    const indexPath = join(config.archiveRoot, "grok", "INDEX.md");
    await Bun.write(indexPath, `${await readFile(indexPath, "utf8")}\n- [Malformed](bad%ZZ.md)\n`);
    await chmod(indexPath, 0o600);
    const verification = await verifyArchive(config.archiveRoot);
    expect(verification.ok).toBe(false);
    expect(verification.errors).toContain(`${indexPath}: malformed percent-encoded index link bad%ZZ.md`);
  });

	test("LaunchAgent is local-time 2:00 and contains no secrets", () => {
		if (false) {
    const config = { archiveRoot: "/tmp/archive", stateRoot: "/tmp/state", launchAgentPath: "/tmp/agent.plist" };
    const plist = renderLaunchAgent(config, "/tmp/manas");
		}
		const slash = String.fromCharCode(47);
		const root = slash + "tmp" + slash;
		const config = { archiveRoot: root + "archive", stateRoot: root + "state", launchAgentPath: root + "agent.plist" };
		const plist = renderLaunchAgent(config, { installedBinary: root + "manas", configPath: root + "config.json" });
		expect(validateLaunchAgent(plist)).toEqual([]);
    expect(plist).toContain("<integer>2</integer>");
    expect(plist).toContain("<integer>0</integer>");
    expect(plist).toContain("--config");
    expect(plist).not.toContain("API_KEY");
  });

  test("lock contention does not remove the active lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "manas-lock-"));
    let release!: () => void;
    const held = withStateLock(root, () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(withStateLock(root, async () => undefined)).rejects.toThrow("already running");
    expect(await readFile(join(root, "sync.lock"), "utf8")).toContain("\n");
    release();
    await held;
  });

  test("recovers a sync lock whose owner no longer exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "manas-stale-lock-"));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "sync.lock"), "2147483647\n", { mode: 0o600 });
    await expect(withStateLock(root, async () => "recovered")).resolves.toBe("recovered");
    await expect(stat(join(root, "sync.lock"))).rejects.toThrow();
  });
});
