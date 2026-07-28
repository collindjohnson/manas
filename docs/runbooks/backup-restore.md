# Backup and restore

Back up the canonical Git repository and PostgreSQL operational database before upgrades. Restore Git first, verify the expected head and metadata, restore the database, run migration verification, and rebuild projection state from the selected Git commit.

Do not reverse-write restored projection rows into Git.
