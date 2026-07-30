---
name: setup-manas
description: Set up local Manas chat synchronization for Codex, Claude Code, Pi, Cursor, Grok, and other supported coding agents. Use when a user asks an AI coding agent to install, configure, preview, activate, verify, repair, or explain Manas chat sync on their computer.
---

# Setup Manas

Guide the user through Manas setup without choosing an archive or enabling a scheduler on their behalf.

## Workflow

1. Confirm the `manas` command is available. For a verified release binary that is not yet installed, run its `install` subcommand. In a source checkout where it is not installed, replace `manas` in every command below with `bun run src/cli.ts`.
2. Inspect without mutation:

   ```sh
   manas setup --detect-only --json
   ```

3. Summarize detected providers, readable conversations, and warning/failure counts. Explain that the default archive is Manas-owned. If the user wants Obsidian, iCloud, or another location, collect an explicit archive path.
4. Ask the user to approve the archive location before writing configuration.
5. Generate a read-only preview using the approved location:

   ```sh
   manas setup --preview --archive <approved-path> --json
   ```

   Omit `--archive` when the user approves the Manas default.

6. Report exact create, update, skip, warning, and failure totals. Do not continue if failures are nonzero.
7. Ask for explicit approval to perform the initial sync and enable the daily macOS scheduler. Offer configuration without scheduling when requested.
8. After approval, run one of:

   ```sh
   manas setup --yes --archive <approved-path> --json
   manas setup --yes --archive <approved-path> --no-schedule --json
   ```

9. Verify archive integrity and inspect scheduler status using the `configPath` returned by setup:

   ```sh
   manas verify --config <config-path>
   manas sync-status --config <config-path>
   ```

10. Report the configured archive, detected providers, initial totals, scheduler state, last successful sync, and warnings.

11. For a broken installed scheduler, use the release binary's repair mode and require a fresh preview/approval. For an old chat-history-sync LaunchAgent, explain that it is retained by default; only run `manas setup --retire-legacy --yes --json` after the user explicitly approves its timestamped backup and unload.

12. For legacy restoration, use the backup manifest to restore the saved plist and load it for the current GUI user. For uninstall, retire or unload the scheduler first; remove the binary/configuration next; delete archive and state only with explicit approval because they contain retained conversation data.

## Guardrails

- Never pass `--yes` until the user has seen the preview and explicitly approved the destination and activation.
- Never replace or merge an existing archive during ordinary setup.
- Stop on source, archive-verification, configuration, sync, or scheduler failures. Report any completed changes precisely.
- Treat ChatGPT and consumer Claude as export imports unless Manas reports a supported local adapter.
- Keep secrets out of configuration, plist files, prompts, and reports.
- Tell users to verify downloaded release checksums and select Apple Silicon versus Intel artifacts before installation. A source checkout is a development/manual-sync path, not a scheduler installation path.
- If Gatekeeper blocks a verified artifact, ask for architecture, `manas --version`, setup JSON, receipt status, and safe log paths; obtain a fresh verified release instead of bypassing Gatekeeper.
