---
name: manas-capture
description: Persist a user-authorized personal memory in Manas with provenance and a deduplicated write receipt.
---

Use `memory.remember` with text, idempotencyKey, provenance, and appropriate visibility labels. A direct request to remember an assertion authorizes that capture. Automatic extraction requires the user's opt-in setting; encountering interesting material alone does not authorize capture.

Keep assertions scoped and include uncertainty and relevant validity dates. Record sourceType and available sessionId, turnId, sourceId, or observedAt. Use the same idempotency key and identical input when retrying a lost response. Derive a stable key from session, turn, and assertion identity when those identifiers are available.

Return the stable memory ID and memory revision from the receipt. Check currentStatus on a replay: an older capture receipt does not reactivate a withdrawn memory. Do not manufacture provenance, strip visibility labels, or use generic page writes to bypass the memory lifecycle.

CLI equivalent: `manas remember --input <JSON>`. Missing local models do not prevent explicit memory capture.
