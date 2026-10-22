# Durable catalog execution

Manas can execute an ordered, bounded tool plan through its configured operation registry. This is the executable counterpart to the older `agent.start/status/update` intent API, which remains available for compatibility.

The local service owns execution jobs and operational state. CLI calls connect to it; with the service stopped, standalone commands use the same exclusive store lock. Plans, resolved inputs, input hashes, results, result hashes, attempts, budgets, and failures survive process restarts and projection rebuilds. They are operational history outside the Git repository.

## Start and inspect a plan

After canonical cutover:

```sh
manas execution start --input '{"idempotencyKey":"juniper-brief-1","steps":[{"operation":"retrieval.search","input":{"query":"Juniper owner"},"maximumOutputTokens":32768},{"operation":"retrieval.get","input":{"id":{"$result":{"step":0,"path":["results",0,"citation","documentId"]}}}}]}'
manas execution status --input '{"id":"<returned-id>"}'
manas execution list --input '{"limit":50}'
manas execution cancel --input '{"id":"<returned-id>"}'
```

For a brain without a canonical selection, add `--repo <brain-directory> --store <external-runtime-directory>`. A stopped service can be replaced by `manas jobs run-one` calls using those same paths. The installed service runs queued work automatically.

The TypeScript exports are `startExecution`, `executionStatus`, `listExecutions`, `cancelExecution`, and `catalogExecutionHandler`. The schema-backed catalog operations use the corresponding `execution.*` names. These operations require unrestricted local owner administration; a client visibility grant does not grant owner access.

A start idempotency key belongs to the owner principal and brain. Reusing it with the same normalized plan returns its existing execution; changing the plan or budget returns `idempotency_conflict`. It does not rerun a failed or completed execution. To authorize a changed plan, use a new key.

A `$result` reference selects JSON from an earlier completed step. Future/self references, missing paths, and prototype properties are rejected. References use persisted tool results after recovery. When a later tool consumes citations, that tool validates their current evidence revisions and authorization again.

## Operations and write policy

Read plans can search/get related evidence, recall active memories, deliver bounded context, resolve entities, traverse typed relationships, and inspect existing answers and pinned questions. The exported `EXECUTION_READ_OPERATIONS` list is authoritative. Retrieval inside a budgeted plan uses lexical mode so it does not initiate unmetered inference calls. Generation and arbitrary shell, network, administrative, or nested execution tools are outside this executor's allowlist.

By default, plans cannot write knowledge. To enable creation of bounded, Manas-owned entity/relationship records, explicitly set this in the versioned configuration and restart the service:

```json
{
  "configVersion": 1,
  "automation": { "managedWrites": true }
}
```

Merge this setting into the existing configuration. The allowed writes are `entities.put` and `relationships.put`. Their evidence, visibility, validity, and ambiguity checks still apply. A plan cannot supply an existing record ID, revision, or idempotency key. The executor supplies a durable key for each step. An ambiguous entity becomes an owner review proposal; the executor cannot approve a merge. Corrections, withdrawals, destructive page changes, and review decisions remain outside the allowlist. Disabling the loaded setting stops subsequent work; cancel active executions when changing configuration before a restart.

A crash after a Git write but before saving a tool result replays the same catalog idempotency key. This recovers the existing write instead of adding another record. Completed steps are skipped on retry.

## Budgets, cancellation, and receipts

Plans contain 1–32 steps. `budget` accepts:

| Field | Default | Limit |
| --- | --- | --- |
| `maximumItems` | Three attempts per planned step | 1–128 attempted tool calls |
| `maximumTokens` | 131,072 | 256–1,048,576 |
| `maximumRuntimeMs` | 60,000 | 100–600,000 |

Each step can set `maximumOutputTokens` (default 16,384; 128–131,072) and `timeoutMs` (default 5,000; 50–30,000). The executor conservatively accounts for serialized tool data using one UTF-8 byte per token unit. These counters are a bound on tool context, not a report of model tokenizer usage. Resolved input is limited to 64 KiB, and the submitted plan to 256 KiB.

Before each attempt it durably reserves the input plus maximum output and the entire step timeout. Reservations are never reset or refunded after a crash, failure, or short result. A plan stops before a call when the remaining budget cannot admit it. A step has at most three attempts; the queue also has a bounded plan-wide retry count. Retryable catalog failures retry; permanent errors and exhausted budgets remain visible in receipts and the failed job.

The worker renews both queue and execution leases. Lost leases prevent result publication and later tool calls. Cancellation is durable and signals in-flight tools, then prevents subsequent steps and late result publication. It does not undo a Git mutation already committed or in progress when cancellation is observed. Likewise, a tool may have committed a bounded write before returning an oversized result or timing out; inspect the execution and Git receipts before authorizing a new plan.

Generic job cancellation and dependency-tree cancellation also cancel their attached executions atomically. Backup restore cancels unfinished executions and jobs before rebuilding projections; restored installations do not resume old authority automatically.

Ordinary status responses contain summaries, hashes, usage, and stable failure codes. To inspect saved tool outputs, explicitly request `includeHistoricalResults:true` as the owner. Those results are historical receipts: they may include evidence subsequently corrected, expired, or withdrawn. They are never ordinary retrieval evidence, automatically delivered context, or a source for fact extraction. Use current retrieval to obtain current citations.
