# Manas

Manas is a local-first, Git-backed knowledge system for syncing, indexing, and searching AI conversations and other personal knowledge sources. Your canonical knowledge lives in a repository you own; rebuildable indexes, embeddings, credentials, and runtime state remain local.

## Quick start

```sh
bun install
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
manas sync [--provider <name>] [--dry-run]
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

## Configuration and privacy

All product environment variables use the `MANAS_` prefix. Set `MANAS_STATE` to choose local state storage and `MANAS_BRAIN_REPOSITORY` (or `--repo`) to choose the knowledge repository.

`serve` starts a local MCP server. For loopback HTTP MCP, set a non-secret local token with `MANAS_MCP_TOKEN` and use `MANAS_MCP_SCOPES` to restrict access. Do not put credentials or local state inside the repository.

Manas can optionally use ZeroEntropy for managed semantic retrieval. That sends bounded transcript chunks to the configured service. Local PGLite embeddings are the privacy-preserving path; `health` reports optional remote services as degraded when unavailable.

## Development

```sh
bun run full-verification
```

The release gate validates capability parity, runbooks, a disposable pgvector/PostgreSQL contract, secret scanning, tests, typechecking, formatting, build output, and `git diff --check`.

## License

[MIT](LICENSE) © 2026 Collin Johnson.
