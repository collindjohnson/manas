# Maintained answers and feedback

Grounded answers return an `answerId` and persist an immutable receipt outside
the Git repository. Receipts retain the exact evidence revisions, Git commits,
source spans, hashes, and authorization scope. Ad hoc receipts are accessible to
their requesting principal and the owner. Every read rechecks current Git,
visibility, memory validity, withdrawal, and source bytes. Stale results expose
freshness and a reason without returning the old answer.

Pinned questions are Git-backed definitions with stable IDs, visibility labels,
revision checks, and idempotent writes. Generated answers are operational caches;
they are never indexed as primary evidence. Question definitions are excluded
from primary retrieval as well.

```sh
manas --config /absolute/path/manas.json questions put --input '{"question":"Who owns Juniper?","idempotencyKey":"juniper-owner","visibility":["personal"]}'
manas --config /absolute/path/manas.json questions list
manas --config /absolute/path/manas.json questions refresh --input '{"id":"<question-id>"}'
manas --config /absolute/path/manas.json questions get --input '{"id":"<question-id>"}'
manas --config /absolute/path/manas.json answers get --input '{"answerId":"<answer-id>"}'
```

Refresh jobs use the question's authoritative visibility grant, the configured
local model, bounded generation, lease renewal, cancellation checks, and immutable
answer receipts. Repeated delivery of a completed refresh reuses its receipt.
Requests within one minute for the same definition share a queue item. Inspection
returns `missing`, `current`, or `stale`; cached answers expire after one hour.
Evidence changes, corrections, withdrawals, permission changes, and question
revisions invalidate cached content on read, including after projection rebuild.

Ratings require an answer ID and an idempotency key, accept -1, 0, or 1, and store
the exact cited revisions. One principal can submit one rating per answer;
duplicate submissions do not add influence. Reset removes that principal's rating.
Ranking influence is disabled.

```sh
manas --config /absolute/path/manas.json answers feedback --input '{"answerId":"<answer-id>","rating":1,"idempotencyKey":"rating-1"}'
manas --config /absolute/path/manas.json answers feedback-reset --input '{"answerId":"<answer-id>"}'
```

These operations are also exposed through MCP and TypeScript. Maintenance scans
queue stale or missing pinned answers for refresh. Schedule maintenance through
the durable job scheduler; the owner UI displays freshness and provides a
manual refresh action. Proposal review is available in the same UI.
