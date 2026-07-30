# Manas

Manas is a local-first, Git-backed knowledge system for syncing, indexing, and searching AI conversations and other personal knowledge sources. Your canonical knowledge lives in a repository you own; rebuildable indexes, embeddings, credentials, and runtime state remain local.

## Quick start

```sh
bun install
bun run src/cli.ts setup --detect-only --json
bun run src/cli.ts setup --preview --json
# After reviewing the preview:
bun run src/cli.ts setup --yes --json
```

`setup` detects local Claude Code, Codex, Pi, Cursor, and Grok chats, previews the first sync, and requires explicit `--yes` approval before enabling the daily macOS scheduler. Synced Markdown stays in Manas's own data area by default.

To use an Obsidian vault or another archive location:

```sh
bun run src/cli.ts setup --preview --archive <archive-path> --json
```

The knowledge-repository workflow remains available separately:

```sh
bun run src/cli.ts brain init --repo <knowledge-repository>
bun run src/cli.ts capture "A thought worth keeping" --repo <knowledge-repository>
bun run src/cli.ts brain index --repo <knowledge-repository> --store <local-pglite-directory>
bun run src/cli.ts brain search --repo <knowledge-repository> --store <local-pglite-directory> --query "what did we decide?"
```

The `brain` commands create and maintain Markdown pages in a separate Git repository. Every mutation is revision- and commit-aware, deletion is recoverable, and indexing reads an immutable Git snapshot. Manas also imports local exports from supported AI tools and can synchronize local Markdown and text folders.

## Local semantic search with Ollama

Run an OpenAI-compatible embedding endpoint locally, then index embeddings into the local PGLite store:

```sh
ollama pull nomic-embed-text
bun run src/cli.ts brain embed --store <local-pglite-directory> --embedding-endpoint http://127.0.0.1:11434/v1/embeddings --embedding-model nomic-embed-text --embedding-dimensions 768
```

Use the same endpoint, model, and dimensions for semantic retrieval. Vectors stay in local PGLite; Markdown in the knowledge repository is unchanged.

## Commands

```sh
manas setup [--archive <path>] [--yes] [--no-schedule] [--detect-only|--preview|--repair] [--retire-legacy] [--json]
manas sync [--config <path>] [--provider <name>] [--dry-run|--scheduled]
manas install
manas sync-status [--config <path>]
manas import chatgpt <zip-or-json>
manas import claude <zip-or-json>
manas brain init --repo <knowledge-repository>
manas brain index --repo <knowledge-repository> --store <local-pglite-directory>
manas brain search --repo <knowledge-repository> --store <local-pglite-directory> --query <query>
manas serve
```

Run commands during development with `bun run src/cli.ts`. The package also exposes a TypeScript API:

```ts
import { BrainRepository, openPgliteBrainStore, indexBrainRepository } from "manas";
```

## Set up Manas with a coding agent

The repository includes the [setup-manas skill](skills/setup-manas/SKILL.md) for Codex and other skill-aware agents. This vendor-neutral prompt also works with Claude Code, Pi, and similar terminal agents:

> Set up Manas chat sync on this computer. First detect supported local coding-agent chats and show me the results. Use Manas's default archive unless I choose another location. Preview every create and update, stop on failures, and ask for my explicit approval before performing the initial sync or enabling the daily scheduler. Verify the archive and scheduler when finished.

Agents should use the structured two-stage flow:

```sh
manas setup --detect-only --json
manas setup --preview --json
# Run only after the user approves the preview:
manas setup --yes --json
```

Use `--archive <path>` consistently in the preview and final command when the user selects an external archive. Use `--no-schedule` for manual sync only.

ChatGPT and consumer Claude currently use export imports. Automatic local discovery covers Claude Code, Codex, Pi, Cursor, and Grok.

## Configuration and privacy

Setup stores the chat archive, state, logs, and non-secret configuration in Manas-owned user data locations by default. `setup --detect-only --json` reports the resolved paths before anything is written. Supply `--archive` only when chats should live in an external vault or folder.

All product environment variables use the `MANAS_` prefix. Set `MANAS_STATE` to choose local state storage and `MANAS_BRAIN_REPOSITORY` (or `--repo`) to choose the knowledge repository.

`serve` starts a local MCP server. For loopback HTTP MCP, set a non-secret local token with `MANAS_MCP_TOKEN` and use `MANAS_MCP_SCOPES` to restrict access. Do not put credentials or local state inside the repository.

Manas can optionally use ZeroEntropy for managed semantic retrieval. That sends bounded transcript chunks to the configured service. Local PGLite embeddings are the privacy-preserving path; `health` reports optional remote services as degraded when unavailable.

## Development

```sh
bun run full-verification
```

The release gate validates capability parity, runbooks, a disposable pgvector/PostgreSQL contract, secret scanning, tests, typechecking, formatting, build output, and `git diff --check`.

## Releases

Releases are created by pushing a version tag that exactly matches `package.json`, for example `v0.1.0`. The release workflow reruns the full verification gate, compiles native macOS binaries (`manas-darwin-arm64` and `manas-darwin-x64`), and publishes both with a `SHA256SUMS` checksum manifest.

To prepare the same artifacts locally:

```sh
MANAS_RELEASE_TAG=v0.1.0 bun run build:release
(cd dist && shasum -a 256 -c SHA256SUMS)
```

The tag check prevents publishing binaries whose package version and release version differ.

## Installing a release binary

Choose the artifact that matches your Mac: `manas-darwin-arm64` for Apple Silicon and `manas-darwin-x64` for Intel. Download its ZIP and the matching `SHA256SUMS` release asset, then verify the checksum from the directory containing both files:

```sh
shasum -a 256 -c SHA256SUMS
unzip manas-darwin-arm64.zip
```

Replace `darwin-arm64` with `darwin-x64` for an Intel Mac. Use the verified release binary's `install` subcommand to atomically install or upgrade the user-local `manas` command, then run `manas --version`. A source checkout is supported for development and manual `--no-schedule` sync only; scheduling, repair, and self-install require a release binary.

For a safe first run, use the detect and preview commands shown above before `setup --yes`. Scheduled runs leave secure receipts below the configured state directory. Archive Markdown, local state, logs, PGlite data, configuration, and scheduler plist files remain on the machine; inspect the setup JSON for resolved locations.

## Repair, legacy restoration, and uninstall

On macOS, use the installed release binary to repair a scheduler only after reviewing the current configuration and expected archive:

```sh
manas setup --repair --yes --json
```

Legacy chat-history-sync jobs are retained by default. After explicit consent, retire one with `manas setup --retire-legacy --yes --json`. Its timestamped backup contains a manifest and the original plist. To restore it, copy that plist back into the user LaunchAgents directory and load it with `launchctl bootstrap` for the current GUI user.

To uninstall Manas, unload or retire the scheduler first, remove the installed `manas` binary and configuration, then delete archive and state directories only if their retained conversation data is no longer wanted.

If macOS Gatekeeper blocks an otherwise verified release, inspect its signing and quarantine status with Finder or `spctl`, then obtain and verify a fresh release artifact rather than bypassing verification. For release troubleshooting, include the selected architecture, `manas --version`, setup JSON, receipt status, and the safe log paths reported by setup.

## License

[MIT](LICENSE) © 2026 Collin Johnson.
