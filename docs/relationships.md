# Entities and relationships

Entities and typed relationships are Git-backed records with stable IDs,
revision checks, idempotent writes, confidence, visibility, and optional validity
periods. Each assertion requires one to ten current citations. Manas verifies
the document revision, immutable commit, source span, content hash, tenant,
brain, and current visibility. Corrections, withdrawals, expiry, deletion, and
permission changes suppress dependent assertions immediately.

Use citations returned by `retrieval.search` as evidence. The following command
groups expose the same operations through CLI, MCP, and TypeScript:

- `entities put`: name, entityType, aliases, confidence, evidence,
  idempotencyKey, optional visibility, validFrom, validUntil, id, expectedRevision.
- `entities resolve`: query by exact name, alias, or ID.
- `relationships put`: fromId, toId, relationshipType, confidence, evidence,
  idempotencyKey, optional visibility, validFrom, validUntil, id, expectedRevision.
- `relationships query`: from, optional to, maximumDepth, maximumResults,
  direction, and relationshipTypes.
- `entities reviews`: owner-only inspection of ambiguous entity proposals.

For example:

```sh
manas --config /absolute/path/manas.json entities resolve --input '{"query":"Juniper"}'
manas --config /absolute/path/manas.json relationships query --input '{"from":"Maya","to":"Denver","maximumDepth":3}'
manas --config /absolute/path/manas.json relationships query --input '{"from":"Juniper","direction":"inbound","relationshipTypes":["owns"]}'
```

Alias comparisons normalize Unicode, whitespace, and case. A colliding write
creates a pending merge proposal instead of merging identities. Read-only queries
report ambiguity without choosing an identity. Stale proposals omit their
derived content. The owner can resolve proposals through the
[entity review workflow](entity-review.md), with revision checks and resumable
merge, separate, and reject decisions.

Relationship writes cannot select visibility narrower than their endpoints and
evidence require. Queries filter entities, relationships, and all citations before
traversal. Results expose every relationship's type, ID, revision, confidence,
validity, and citations. The planner follows outbound, inbound, or both directions
for at most three hops, 100 results, 500 expansions, and 20,000 edge inspections.
Its plan reports truncation. Graph scans have a 2,000-record budget.

Graph assertions and review proposals are excluded from primary evidence, along
with pinned definitions and generated answers. They cannot reinforce themselves
through retrieval or supply citations for another assertion. Existing wiki-link
retrieval remains available.
