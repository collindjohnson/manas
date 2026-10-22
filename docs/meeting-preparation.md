# Meeting preparation, open loops, and reminders

Open loops are Git-backed commitments with current source citations, participants,
an optional due timestamp, and an explicit open, done, or cancelled status. They are
derived records and never become primary retrieval or extraction evidence.

Use the shared operation catalog through CLI, MCP, or TypeScript:

- `loops.put`: title, evidence, idempotencyKey, optional participants/dueAt/visibility;
  updates additionally require id and expectedRevision.
- `loops.status`: id, expectedRevision, status, idempotencyKey.
- `loops.get` and `loops.list`: current authorized records; list supports participant,
  status, limit, and after. Owner includeStale returns only stale record metadata.
- `meetings.prepare`: idempotencyKey and a meetingId, title, or participants.
  Optional since and maximumEvidence bound retrieval.
- `meetings.get`: fetch a persisted brief by id.
- `reminders.list`: current due commitments with delivery state.
- `reminders.enqueue`: owner-only local notification request for id/expectedRevision.

For example, use `manas loops put --input <json>` or
`manas meetings prepare --input <json>`. JSON evidence must contain exact citations
returned by current retrieval. Writes inherit every supporting source visibility
label and retain existing restrictions. Concurrent writes require current revisions.

Loop retries return the latest revision and status plus a stable writeId and the
original operation status. Replaying an old create or close never undoes a later
change. Closing a stale commitment is allowed; reopening requires current evidence.
The bounded receipt ledger reserves capacity for closing a loop.

Meeting preparation retrieves participant entities, primary source excerpts, and
matching open loops. Calendar event JSON can provide participant selectors.
Participant selectors and a supplied title are search inputs, not asserted facts.
Briefs are extractive and work without a generation model. Configured local
embedding/reranking providers are used when available. Missing timestamps are
reported as unknown recency; older dated interactions are excluded by since.
Each brief stores exact evidence and dependency revisions, expires after one hour,
and revalidates on read. Changed, withdrawn, expired, or inaccessible evidence and
changed commitments invalidate the brief; stale responses contain metadata only.
Refresh using a new idempotency key. Briefs are bound to their requesting principal;
the unrestricted owner may inspect them.

The runtime meeting-preparation job invokes this same implementation with a stable
job key, renews its lease, and stores a preparation ID in progress. A reminders job
scans current due commitments. It exposes reminders to clients by default; a
persisted owner job or schedule with explicit notify:true requests native delivery.
Enqueueing an individual reminder is also explicit notification authorization.
Delivery is scheduled at the due timestamp, and rechecks the loop and source
authorization before dispatch.

Notification receipts and queue intent are durable operational state. One delivery
is identified by brain, loop revision, and due timestamp. The OS message contains
only static text asking the owner to open Manas; source content stays out of
Notification Center. Delivered means macOS accepted the notification command,
not that the owner saw it. OS dispatch and receipt persistence cannot be atomic:
a crash after dispatch reservation produces uncertain and never silently resends.
A notifier error is also uncertain. Review the receipt; an intentional loop update
and a new explicit request can produce a fresh delivery. Cancelling an in-flight
OS command cannot retract a notification already accepted by macOS.

Backup restore cancels queued work, disables schedules, and suppresses pending
reminder receipts until the owner reviews and authorizes new work. Raw client
reads/exports exclude derived records; typed APIs revalidate their evidence.
Explicit owner history retains Git content and therefore is not an erasure flow.

The [owner browser UI](owner-ui.md) exposes commitments, reminders, and meeting
preparation. Real desktop notification smoke verification remains part of rollout. Tests inject a notifier and never send desktop notifications.
