# Manas

Manas is a local-first, Git-backed knowledge system for syncing, indexing, and searching AI conversations and other personal knowledge sources. Your canonical knowledge lives in a repository you own; rebuildable indexes, embeddings, credentials, and runtime state remain local.

## Quick start

```sh
bun install
bun run src/cli.ts setup --detect-only --json
bun run src/cli.ts setup --preview --json
# After reviewing the preview:
bun run src/cli.ts setup --yes --no-schedule --json
```

This source-checkout flow is intended for development and manual synchronization. For self-installation and the daily macOS scheduler, use a release binary as described below. `setup` detects local Claude Code, Codex, Pi, Cursor, and Grok chats and previews the first sync. Synced Markdown stays in Manas's own data area by default.

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

## Canonical personal brain

For the shared runtime, create a configuration outside the brain. For example:

```json
{
  "stateRoot": "/absolute/manas-state",
  "archiveRoot": "/absolute/retained-archive",
  "providers": {
    "generation": {
      "endpoint": "http://127.0.0.1:11434/v1/chat/completions",
      "model": "qwen3.8:27b",
      "privacy": "local"
    }
  }
}
```

Replace the absolute paths and select an installed local model, or omit
`providers` to start with lexical retrieval. Initialize a new brain and start the
foreground service:

```sh
manas --config /absolute/manas.json brain init --repo /absolute/brain
manas --config /absolute/manas.json service start --repo /absolute/brain
```

From another terminal:

```sh
manas --config /absolute/manas.json remember --input '{"text":"Juniper owner is Maya.","provenance":{"sourceType":"user"},"idempotencyKey":"juniper-owner"}'
manas --config /absolute/manas.json recall --input '{"query":"Juniper"}'
manas --config /absolute/manas.json agents preview codex
manas --config /absolute/manas.json ui open
```

CLI, MCP, hooks and background jobs share this service, its authorization and
configured providers. The service exclusively owns PGLite; Git remains canonical.
Operational state stays outside the brain. Install and verify Codex or Claude
Code with the [agent integration guide](docs/agent-integration.md), including
explicit Codex hook trust and opt-in capture. Use the
[macOS service guide](docs/macos-service.md) for persistent startup.

For an existing archive, follow the [migration and cutover flow](docs/runbooks/operator.md#archive-migration-and-canonical-selection)
instead of replacing it: backup, preview, resumable copy, shadow retrieval,
explicit activation, and retained rollback receipts. Existing sync adapters and
consumer export imports remain available.

## Local semantic search with Ollama

Run an OpenAI-compatible embedding endpoint locally, then index embeddings into the local PGLite store:

```sh
ollama pull nomic-embed-text
bun run src/cli.ts brain embed --repo <knowledge-repository> --store <local-pglite-directory> --embedding-endpoint http://127.0.0.1:11434/v1/embeddings --embedding-model nomic-embed-text --embedding-dimensions 768
```

Use the same endpoint, model, and dimensions for semantic retrieval. You can instead configure `providers.embedding` once and run `brain embed` without model flags. When the shared service is running, model flags must match its configuration. Vectors stay in local PGLite; Markdown in the knowledge repository is unchanged.

To use the same local provider for the default archived-chat index and MCP `search` tool, put it in the configuration written by `manas setup`. Installed commands automatically load the setup-generated user configuration:

```sh
manas index
manas search "what did we decide?" --semantic-only
```

Configuration-file selection follows `--config`, then `MANAS_CONFIG_FILE`, then the setup-generated `.config/manas/config.json` file in your home directory, and finally built-in defaults. `--config` is global and may appear before or after the command. Legacy archive indexing and semantic retrieval use the configured local embedding provider. Without a local model, lexical retrieval remains available; semantic-only retrieval reports missing local configuration. Retained ZeroEntropy settings do not activate a hosted fallback. `manas serve` uses the same configuration for MCP search.

`embeddinggemma-2` uses separate query and document retrieval prefixes, recorded in the embedding fingerprint. After switching models, run `manas index` to generate the replacement vectors; previous model vectors remain separate. Archive search uses shared project and repository relationships only to break retrieval-score ties, so dense clusters of approval logs cannot override stronger query matches.

Normal archive searches prefer conversations over machine-generated approval transcripts and injected context records. Queries that explicitly ask about approvals, permissions, authorization, or the injected context use the full relevance ranking. `--explain` includes `sourcePriority` so this preference is visible.

## Commands

```sh
manas [--config <path>] setup [--archive <path>] [--yes] [--no-schedule] [--detect-only|--preview|--repair] [--retire-legacy] [--json]
manas [--config <path>] sync [--provider <name>] [--dry-run|--scheduled]
manas install
manas [--config <path>] sync-status
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

Manas-managed inference uses configured local models through loopback endpoints.
Hosted privacy settings and explicit Ollama `:cloud` / `-cloud` model selectors
are rejected. Provider requests do not follow redirects. The request deadline
covers the complete response body, and responses are limited to 16 MiB.
Use a trusted local inference service; a loopback address alone cannot prove what
an independently configured proxy does internally.

Lexical retrieval works without models. Generation reports an actionable local
configuration error. Legacy ZeroEntropy configuration and archived data are
retained but do not trigger retrieval, generation, or health requests to that
service. Command-based generation is not an automatic fallback.

## Development

```sh
bun run full-verification
```

The release gate validates capability parity, runbooks, a disposable pgvector/PostgreSQL contract, secret scanning, tests, typechecking, formatting, build output, and `git diff --check`.

## Releases

Releases are created by pushing a version tag that exactly matches `package.json`, for example `v0.1.1`. The release workflow reruns the full verification gate, compiles native macOS binaries (`manas-darwin-arm64` and `manas-darwin-x64`), applies an ad-hoc signature, and publishes both with a `SHA256SUMS` checksum manifest and GitHub build-provenance attestations. Release binaries are not signed with an Apple Developer ID or notarized by Apple.

To prepare the same artifacts locally:

```sh
MANAS_RELEASE_TAG=v0.1.1 bun run build:release
(cd dist && shasum -a 256 -c SHA256SUMS)
```

The tag check prevents publishing binaries whose package version and release version differ.

## Installing a release binary

Choose the artifact that matches your Mac: `manas-darwin-arm64` for Apple Silicon and `manas-darwin-x64` for Intel. Download its ZIP and the matching `SHA256SUMS` release asset, then verify the checksum from the directory containing both files:

```sh
shasum -a 256 -c SHA256SUMS
unzip manas-darwin-arm64.zip
```

Replace `darwin-arm64` with `darwin-x64` for an Intel Mac. Because the public binaries are not Apple-notarized, macOS may quarantine the downloaded executable. After verifying the checksum, remove quarantine from that executable:

```sh
xattr -d com.apple.quarantine manas
chmod +x manas
env PATH=".:$PATH" manas install
export PATH="$HOME/.local/bin:$PATH"
manas --version
manas setup --detect-only --json
manas setup --preview --json
# After reviewing the preview:
manas setup --yes --json
```

The `install` subcommand atomically installs or upgrades the user-local `manas` command. Add the displayed `PATH` export to your shell profile if a later terminal cannot find it. A source checkout is supported for development and manual `--no-schedule` sync only; scheduling, repair, and self-install require a release binary.

For a safe first run, use the detect and preview commands shown above before `setup --yes`. Scheduled runs leave secure receipts below the configured state directory. Archive Markdown, local state, logs, PGlite data, configuration, and scheduler plist files remain on the machine; inspect the setup JSON for resolved locations.

## Repair, legacy restoration, and uninstall

On macOS, use the installed release binary to repair a scheduler only after reviewing the current configuration and expected archive:

```sh
manas setup --repair --yes --json
```

Legacy chat-history-sync jobs are retained by default. After explicit consent, retire one with `manas setup --retire-legacy --yes --json`. Its timestamped backup contains a manifest and the original plist. To restore it, copy that plist back into the user LaunchAgents directory and load it with `launchctl bootstrap` for the current GUI user.

To uninstall Manas, unload or retire the scheduler first, remove the installed `manas` binary and configuration, then delete archive and state directories only if their retained conversation data is no longer wanted.

If macOS still blocks a checksum-verified release after quarantine is removed, inspect its ad-hoc signature with `codesign --verify --strict --verbose=2 manas` and obtain a fresh release artifact if verification fails. For release troubleshooting, include the selected architecture, `manas --version`, setup JSON, receipt status, and the safe log paths reported by setup.

## License

[MIT](LICENSE) © 2026 Collin Johnson.

Maintained questions, answer freshness, and revision-bound ratings are documented in
[Maintained answers and feedback](docs/maintained-answers.md).

[Entities and relationships](docs/relationships.md) describes cited entity records,
merge proposals, and bounded relationship queries.

[Google ingestion](docs/google-ingestion.md) documents read-only OAuth setup,
Keychain credentials, account and boundary selection, durable cursors and recurring ingestion.

See [macOS canonical service](docs/macos-service.md) for persistent runtime installation, startup recovery, status, and ownership-aware removal.

See [backup and restore](docs/backup-restore.md) for consistent offline snapshots and a fresh-install recovery flow.

See [entity identity review](docs/entity-review.md) for owner merge, separation, rejection, and interrupted-review recovery.

See [canonical session synchronization](docs/canonical-sync.md) for sync/import routing after cutover, stable archive identities, resumable receipts, and user-edit preservation.

See [durable catalog execution](docs/agent-execution.md) for queued tool plans, persisted step results, cancellation, budgets, and opt-in managed graph writes.

Canonical maintenance scans and review proposals: [maintenance guide](docs/maintenance.md).

See [meetings, commitments, and reminders](docs/meeting-preparation.md) and the [owner browser UI](docs/owner-ui.md) for cited preparation, durable local delivery, and same-origin administration.

Retrieval regression checks run with `bun run evaluation:check`. They retain the original baseline and independently gate 29 development and 29 held-out lifecycle queries, including withdrawal/rebuild suppression, exact citations, permission changes, and bounded relationship chains. See [evaluation methodology and baseline provenance](docs/retrieval-evaluation.md).

Optional selected-device MCP access is documented in [Device access](docs/device-access.md), including preview, ownership-aware removal, explicit Funnel exposure, and recovery.
