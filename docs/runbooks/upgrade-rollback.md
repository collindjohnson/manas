# Upgrade and rollback

Run the reconciliation report before import. Execute ordered migrations with the backup hook, verify every migration, and keep the previous complete projection run readable until activation.

Rollback is explicit only where a migration supplies a safe down operation. Otherwise restore the backup and rebuild from a prior Git commit.
