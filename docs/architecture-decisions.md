# Architecture decisions

## ADR-001: Git Markdown is the authority

Each brain has exactly one private canonical Git repository. Markdown files and
committed `.brain/` metadata are authoritative for pages, revisions, managed source
output, schema-pack selection, and durable logical access policy. Databases are
rebuildable projections and cannot directly mutate knowledge.

## ADR-002: Projections are scoped and rebuildable

PGLite is a single-process, local projection and must never become a shared team
database. PostgreSQL is the hosted projection and every record, index, cache key, and
candidate query must be scoped by tenant and brain before retrieval. Git remains the
rollback source; a failed projection is retried rather than reverse-writing the
database into Git.

## ADR-003: Explicit model and privacy boundaries

Local model mode uses only explicitly configured local endpoints. It must not fall
back to a hosted provider. Model fingerprints include provider, model, revision,
dimensions, normalization, prompt/template version, and privacy class.

## ADR-004: Git-safe mutations and citations

Knowledge mutations use expected document revisions and an expected repository head,
serialize local writers, stage only operation-owned paths, and retain deletion
tombstones. Citations resolve to the brain identity, document UUID, path, content
revision, and immutable Git commit.

## ADR-005: Legacy retention during migration

The legacy archive and existing ZeroEntropy collection remain preserved and are
never automatically deleted. Local embedding vectors may be built as a separate
SQLite projection alongside them. Cutover depends on reconciliation and shadow
verification; rollback switches reads or rebuilds a projection from a verified commit.
