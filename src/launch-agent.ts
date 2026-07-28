import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config } from "./config";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderLaunchAgent(config: Config, projectRoot = resolve(import.meta.dir, "..")): string {
  const bun = Bun.which("bun") ?? process.execPath;
  const cli = resolve(projectRoot, "src/cli.ts");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.collindjohnson.manas</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(bun)}</string>
    <string>${xml(cli)}</string>
    <string>sync</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>3600</integer>
  <key>StandardOutPath</key>
  <string>${xml(resolve(config.stateRoot, "launch-agent.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(resolve(config.stateRoot, "launch-agent.err.log"))}</string>
</dict>
</plist>
`;
}

export function validateLaunchAgent(plist: string): string[] {
  const errors: string[] = [];
  if (!plist.includes("com.collindjohnson.manas")) errors.push("missing LaunchAgent label");
  if (!plist.includes("<integer>2</integer>") || !plist.includes("<integer>0</integer>")) errors.push("missing 2:00 local schedule");
  if (!plist.includes("<key>StartCalendarInterval</key>")) errors.push("missing StartCalendarInterval");
  if (!plist.includes("<false/>") || !plist.includes("<key>RunAtLoad</key>")) errors.push("RunAtLoad must be false");
  if (plist.includes("<key>EnvironmentVariables</key>")) errors.push("plist must not contain environment secrets");
  return errors;
}

export async function installLaunchAgent(config: Config): Promise<string> {
  const plist = renderLaunchAgent(config);
  const errors = validateLaunchAgent(plist);
  if (errors.length) throw new Error(errors.join("; "));
  await mkdir(dirname(config.launchAgentPath), { recursive: true });
  await writeFile(config.launchAgentPath, plist, { mode: 0o644 });
  await chmod(config.launchAgentPath, 0o644);
  return config.launchAgentPath;
}
