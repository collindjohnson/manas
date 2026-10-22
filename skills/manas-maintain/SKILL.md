---
name: manas-maintain
description: Inspect Manas source and job health and prepare evidence-backed maintenance proposals for owner review.
---

Inspect authorized source freshness, queued jobs, and integrity before proposing maintenance. Use the catalog's `sources.list`, `jobs.list`, and owner-local integrity operations as permitted. Record the affected source IDs, document revisions, and concrete observed failure.

Use `maintenance.propose` for reviewable findings. The existing proposal operation records a proposal; it does not prove extraction, reconciliation, or repair has run. Inspect execution receipts for any work actually enqueued.

Default to proposals. Apply bounded writes to Manas-owned content only when the owner has explicitly enabled and authorized that maintenance policy. Merges, destructive edits, and ambiguous corrections remain proposals. Do not claim a capability is installed, trusted, or observed working solely because its configuration exists.

Use the shared runtime and job queue rather than opening a second database process. Report missing capabilities or failed jobs accurately and retain evidence for recovery.
