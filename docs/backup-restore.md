# Backup and restore

Use an offline backup to capture the canonical Git brain and its PGLite operational store together. Stop the running service first. An installed persistent service can be unloaded with `manas service uninstall --config <path>`; this preserves the brain and state. Reinstall it after backup. Exclusive runtime, store, and repository fences prevent Manas writers from changing either source during the copy. Avoid editing the Git checkout with other tools during backup.

```sh
manas backup create --config /absolute/config.json --repo /absolute/brain --store /absolute/runtime --to /absolute/new-backup
manas backup verify --from /absolute/new-backup
manas backup restore --from /absolute/new-backup --to /absolute/new-installation
```

The destination parent must exist, and restoration must be outside the backup and original sources. Creation and restoration require a new destination and never overwrite or delete an existing directory. Canonical selection supplies the source paths when available. The shared operation catalog exposes owner-only, local operations `backup.create`, `backup.verify`, and `backup.restore`; creating a backup through a running service returns a store ownership error because this flow is offline.

Backups include all regular Git checkout files, Git history, uncommitted user edits, and the complete operational database: jobs, cursors, retry ledgers, feedback, and receipts. File hashes, sizes, directories, canonical IDs, and commit are recorded in `manifest.json`. Source inventories are compared again after copying. Files and directories are flushed before the completion manifest is published. A missing or invalid manifest means the backup is incomplete. A failed or interrupted attempt leaves its directory available for inspection; retry into a new destination. Verification checks integrity, not cryptographic authenticity.

The repository must be a standalone checkout with self-contained Git objects. Symlinks, special files, external Git alternates, explicit Git worktree redirection, Git environment overrides, more than 100,000 inventory entries, and individual files over 256 MiB are rejected. Creation has a four-minute consistency budget and aborts before publishing a completed manifest when that budget is exceeded. Use a fast local destination.

External credentials and installation settings are excluded: macOS Keychain contents, the service owner token, agent configuration and grants, provider API keys in the Manas configuration, and launchd receipts are outside the copied roots. The brain and operational database may contain private source content and access-token hashes; protect the backup accordingly. Legacy archives and migration receipts outside the canonical repository and selected store are retained in place and should be backed up separately when rollback to that archive is required.

Restoration verifies the backup before creating the destination, preserves canonical document and repository IDs, reopens the operational store, and rebuilds retrieval projections from Git. It writes `config.json`, `state/canonical-runtime.json`, and a final `restore-receipt.json`. Operational history, connector cursors, feedback, and execution receipts survive. Withdrawn memories remain suppressed after rebuild, while explicit owner Git history remains available.

Restored access tokens, OAuth sessions and clients are revoked. Sources and schedules are disabled; pending and running jobs are retained as cancelled records with a review reason. Reconfigure local models, reconnect Google accounts, review source boundaries and revisions, reinstall agent integrations, and explicitly retry reviewed work or enable scheduling. The restore does not activate clients or install a background service. Start the restored installation with:

```sh
manas service start --config /absolute/new-installation/config.json --repo /absolute/new-installation/brain --store /absolute/new-installation/operational
```

A completed restore receipt is the success marker. An interrupted restore leaves an incomplete installation for inspection and does not alter its backup or any existing installation. Retry into a new directory.
