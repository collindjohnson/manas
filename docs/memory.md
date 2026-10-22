# Durable memory

Memory operations commit canonical records to the Git brain. They work through the shared service, CLI, MCP catalog, and TypeScript API. With the service stopped, use an explicit repository and operational store, or the selected canonical runtime.

Create a memory with a caller-generated idempotency key and explicit provenance:

```sh
manas remember --repo /path/to/brain --store /path/to/state/runtime --input '{"text":"Juniper owner is Maya.","idempotencyKey":"session-123:turn-7:capture","provenance":{"sourceType":"user","sessionId":"session-123","turnId":"turn-7"},"visibility":["personal"]}'
manas recall --repo /path/to/brain --input '{"query":"Juniper owner","limit":10}'
```

With the local service running, clients connect to it automatically. Memory writes require write scope; a client must hold every visibility label on an existing record. Optional `validFrom` and `validUntil` timestamps bound when a record appears in ordinary retrieval. The end is exclusive.

A successful write returns a stable `id`, the memory `revision`, status, and Git commit. The memory revision covers the lifecycle update; evidence citations separately identify the document content revision, exact source span, commit, and authorization scope. Use the returned memory revision for a correction or withdrawal:

```sh
manas correct --input '{"id":"<memory-id>","expectedRevision":"<memory-revision>","idempotencyKey":"session-123:turn-8:correction","text":"Juniper owner is Omar.","provenance":{"sourceType":"user","sessionId":"session-123","turnId":"turn-8"}}'
manas forget --input '{"id":"<memory-id>","expectedRevision":"<current-memory-revision>","idempotencyKey":"session-123:turn-9:withdrawal","reason":"Owner requested withdrawal"}'
```

Corrections keep the stable ID and supersede the earlier revision. Omitted visibility and validity fields retain their existing values. Writes require idempotency keys; repeat an identical request with the same key after a timeout or lost response. Reusing a key for different input returns `idempotency_conflict`. Stale expected revisions return `revision_conflict`; review the current record before retrying. A replay reports the original receipt and also `currentStatus` and `currentRevision`, so replaying an earlier capture cannot imply reactivation.

Forgetting withdraws the memory from ordinary recall, verified search, document reads, and graph evidence. Projection rebuilds preserve the suppression. Correcting or forgetting invalidates associated projected facts, claims, and caches when the projection advances; verified retrieval checks Git immediately, including the gap before projection catches up. Withdrawn records cannot be reactivated through correction or generic page operations. A new explicitly authorized assertion uses a new memory and provenance.

Forgetting does **not** delete earlier assertions from Git history. Owner administration can inspect them explicitly with `manas memory history --input '{"id":"<memory-id>"}'`. The history operation is local-only and unavailable to clients constrained by visibility grants. Ordinary exports suppress withdrawn records, including historical versions.

MCP names are `memory.remember`, `memory.recall`, `memory.correct`, `memory.forget`, and `memory.history`. TypeScript exports `remember(repository, context, input)`, `recall`, `correct`, `forget`, and `memoryHistory`. Existing `analysis.recall` and `analysis.forget` remain compatibility helpers for caller-supplied arrays; use the persisted memory operations for durable writes.

Records retain provenance, validity, supersession links, and hashed request receipts in Git-backed source metadata. Each record retains up to 1,000 ordinary lifecycle receipts; reaching that explicit limit requires a new record, without dropping old receipts. A final withdrawal remains available at that limit. The engine repairs a stale projection on startup. Interrupted committed writes can therefore be retried safely after restart without losing the memory.

## Bounded context and agent skills

`context.deliver` returns a quoted, cited packet from local lexical retrieval. It caps output at approximately 2,000 tokens and stops waiting for retrieval after at most 1.8 seconds. No model inference runs on this context path. Visibility, validity, and withdrawal checks still apply.

The repository ships skills in `skills/manas-recall`, `manas-capture`, `manas-correct`, `manas-answer`, and `manas-maintain`. Their instructions use the persisted catalog operations. Automatic installation and hook observation are separate integration work; shipping a skill does not establish that a real agent session loaded it.
