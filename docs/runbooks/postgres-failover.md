# PostgreSQL failover

Stop writes, preserve the canonical Git head, promote the approved database backup, apply the shared ordered migrations, set the transaction-local tenant context, enable RLS, and rebuild the active projection. Verify tenant isolation before reopening writes.

For a disposable contract drill, run `bun run postgres:docker`; it uses the `pgvector/pgvector:pg16` image and removes only its temporary container on exit. For an existing database, set `MANAS_POSTGRES_URL` and run `bun run postgres:check`. The release gate runs `bun run postgres:docker`, so it provisions and tears down the disposable PostgreSQL contract when Docker is available and fails clearly when the daemon or image is unavailable.
