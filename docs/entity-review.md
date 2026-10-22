# Reviewing entity identity

Entity writes with colliding names or aliases create Git-backed reviews rather than merging identities automatically. Inspect them as the owner:

```sh
manas entities reviews --repo /absolute/brain --input '{"limit":50}'
```

The response includes current evidence and candidate revisions for pending reviews, or a `stale` summary when supporting evidence or a candidate changed. `nextCursor` supports pagination. Completed and interrupted reviews return metadata without repeating earlier assertions.

Resolve a current proposal using its review ID, original review revision, and a fresh idempotency key:

```sh
manas entities review --repo /absolute/brain --input '{"id":"REVIEW_ID","expectedRevision":"REVIEW_REVISION","idempotencyKey":"owner-decision-1","decision":"merge","targetId":"CANDIDATE_ID"}'
manas entities review --repo /absolute/brain --input '{"id":"REVIEW_ID","expectedRevision":"REVIEW_REVISION","idempotencyKey":"owner-decision-2","decision":"separate"}'
manas entities review --repo /absolute/brain --input '{"id":"REVIEW_ID","expectedRevision":"REVIEW_REVISION","idempotencyKey":"owner-decision-3","decision":"reject"}'
```

These are alternative decisions, not a sequence. Merge requires a candidate from that proposal. It retains the selected canonical name, combines aliases and verified evidence, takes the lower confidence and overlapping validity interval, and preserves the union of visibility labels. Entity types must agree, and the result must fit the existing limits of twenty aliases and ten citations. Correct incompatible definitions and submit a fresh proposal instead of forcing a merge.

Separate accepts the proposed identity without combining it with a candidate. Queries that still match multiple identities report ambiguity; use an explicit entity ID to disambiguate. Rejection leaves entities unchanged and can dismiss obsolete proposals whose evidence is no longer usable.

Merging two existing entities preserves the earlier entity as a Git-backed redirect. Its stable ID and aliases continue to resolve to the canonical entity. Relationship traversal follows bounded redirect chains, applies visibility and evidence checks at every step, and includes redirect revisions and review IDs in the returned chain. Withdrawal or expiry of supporting evidence suppresses the resulting entities and relationships after projection rebuilds as well.

Resolution first persists an applying intent, then writes the canonical entity, any redirect, and the completed review. After interruption or cancellation, retry the exact same input, including its original expected revision and idempotency key. Review status exposes those resume fields. A different decision cannot replace an applying intent. Replays do not duplicate entity writes. If an owner edit changes a participating record during an interrupted merge, revision checks stop the operation for inspection.

CLI, TypeScript `resolveEntityReview`, and `entities.review.resolve` use the same contract. Resolution requires unrestricted owner administration and is local-only; selected MCP client write grants do not grant merge approval. Ordinary page mutations cannot overwrite graph records to bypass lifecycle checks. Git history remains available to the owner; merged records are retained rather than deleted.
