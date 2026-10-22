# Operator guide

1. Run the full verification gate before a release or migration.
2. Inspect metadata-only health output.
3. Treat a degraded semantic provider as a read-mode condition; lexical retrieval remains local.
4. Rebuild projections from an immutable Git commit after repairing the repository.
5. Record the incident, commit, schema version, tenant/brain scope, and recovery receipt.


## Local runtime service

Start the shared runtime with `manas --config <config.json> service start --repo <git-brain> --store <state-directory>`. The process stays in the foreground. Keep the store and configuration state directory outside the Git brain. Use `service status` to inspect the running brain and `service stop` for a graceful shutdown.

The service owns PGLite, runs scheduled and queued work, and serves authenticated operations over an owner-only Unix socket. Its owner token lives at `<stateRoot>/service/owner.token` with mode 0600. The socket lives in a short, installation-specific owner-only directory under `/tmp` to fit macOS socket path limits. Do not share the owner token with MCP clients; HTTP MCP keeps its separate client token and scope checks.

Catalog commands and stdio/HTTP MCP connect to the service when available. Explicit repository selections must resolve to its canonical brain. When the service is stopped, standalone catalog and MCP runtimes use the configured engine and acquire the same store ownership lock. An occupied store returns `store_owned` with a suggested fix. A failed operation is never retried automatically as a standalone write.

Every persistent PGLite open holds an exclusive SQLite transaction in `.manas-owner.sqlite` inside the store directory. The kernel releases ownership after process death. Leave that permanent file in place; removing it while any runtime is alive could break mutual exclusion. It contains ownership bookkeeping, not canonical knowledge.



## Archive migration and canonical selection

Keep the service stopped during migration and selection changes. Preview with `manas migration preview --from <archive> --repo <new-brain>`, then run `migration resume --id <receipt-id>`. Resume is safe after a stopped copy or a commit whose receipt was not saved. Existing target edits cause a stop rather than replacement. The legacy `brain migrate --from <archive> --repo <brain>` command uses the same receipts and adds `migrationId` to its result; pass `--id <migrationId>` with those arguments to resume. An empty initialized brain is allowed, but an existing knowledge manifest is never replaced.

Run `migration shadow --id <receipt-id> --queries '["your recall query","another query"]'` to compare executed lexical retrieval against the copied Git brain. Inspect the saved results and activate explicitly with `migration activate --id <receipt-id> --expected-head <verified-commit>`. If rankings differ, review the differences before adding `--accept-shadow-differences`. Activation verifies original, backup, and target hashes and builds the projection before saving the default read selection.

`migration rollback` returns the default read selection to the retained archive. Source files, backups, migration receipts, and the Git brain remain available. Receipts and the canonical selection live outside the repository under the configured state directory.

Canonical search, document reads, grounded answers, session synchronization, and consumer export imports use the selected brain after explicit cutover. Before cutover, legacy archive paths remain available. See [Canonical synchronization](../canonical-sync.md) for checkpoint and compatibility behavior, [Durable memory](../memory.md) for lifecycle operations, [Agent integration](../agent-integration.md) for ownership and hook trust, [macOS service](../macos-service.md) for installation, and [Owner UI](../owner-ui.md) for administration, and [optional device access](../device-access.md) for selected Tailscale devices.

Catalog retrieval refreshes a stale projection from canonical Git, sharing one catch-up among concurrent readers. Verified search checks the current Git revision and current visibility labels before returning projected evidence. A withdrawn or revised page is suppressed even before the projection worker catches up. This does not erase Git history.

Session adapters use per-record content and metadata fingerprints. The cursor advances after repository writes and projection scheduling succeed. A late session or an edit with an unchanged timestamp is reconciled on the next scan.
