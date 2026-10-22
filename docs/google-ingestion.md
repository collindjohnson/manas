# Google ingestion foundation

The TypeScript API provides read-only Gmail, Calendar, and Contacts page readers and a durable Git persistence journal. Desktop PKCE authorization, a bounded loopback consent listener, and macOS Keychain credential storage are implemented as TypeScript APIs. Owner-only source catalog operations and paginated background jobs are implemented. The owner connection command and recurring ingestion setup are implemented. Real-account installation verification is still pending. These APIs do not constitute an installed Google connection.

## Explicit boundaries

Every boundary selects an account identity, visibility labels, and service-specific limits. Gmail requires labels, a fixed date interval, and an explicit spam/trash choice. Calendar requires one calendar and a fixed date interval. Contacts requires selected groups or an explicit all-contacts choice. Unknown boundary fields are rejected; credentials do not belong in these records.

The transport restricts GET requests to official Google read endpoints, rejects redirects, bounds response sizes, and sanitizes errors. Its injected token provider must supply credentials for the selected account. The desktop authorization API verifies the selected email through Google userinfo and derives a stable account ID from the verified subject; refreshes recheck that identity. No hosted inference is involved.

Gmail imports selected headers and inline text MIME bodies. Attachments are not fetched. HTML bodies remain inert source text. Calendar imports event resources, including recurring event definitions; it does not expand recurring instances. Contacts imports names, email addresses, phone numbers, organizations, memberships, and metadata from saved contacts.

## Checkpoint and recovery contract

`readGooglePage` reads a page without committing its cursor. `syncGooglePage` owns a fenced source lease and persists the frozen page in operational state before writing documents. It records each successful document write, schedules projection, and advances the cursor in the same operational transaction only after all canonical writes succeed. A crash between Git commit and the journal update replays the same page idempotently. Repeated unchanged sync tokens still permit subsequent polls.

Full scans track seen external IDs across pages. An expired cursor begins reconciliation. Omitted or upstream-deleted records become stale; canonical Git history remains available. Failed pages preserve the last successful checkpoint and record a sanitized retry ledger entry. Source leases use unique invocation tokens, including when workers share a display name.

Gmail captures the starting history ID before listing messages, then replays history from that baseline. A message 404 is retryable unless explicit deletion history proves withdrawal; it cannot silently skip a record or reset the history cursor. Calendar accepts the next sync token only from the final page and omits incompatible date parameters during delta requests. Contacts preserves its person fields and source parameters and recognizes the documented expired-token response.

Operational tables are scoped by tenant and brain and covered by PostgreSQL row-level-security contracts. Operational state must live outside the canonical repository. Retain it together with Git when implementing consistent backups.

## Verification

`bun test tests/google-sync.test.ts tests/source-sync.test.ts` exercises transport limits, refresh-once behavior, boundary rejection, pagination failures, expired cursors, deletion proof, commit/checkpoint crashes, unchanged tokens, reconciliation, and concurrent workers. `bun run postgres:docker` verifies schema migration, crash replay, and cross-tenant isolation against PostgreSQL.

Official API contracts: [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync), [Calendar synchronization](https://developers.google.com/workspace/calendar/api/guides/sync), and [Contacts incremental synchronization](https://developers.google.com/people/v1/contacts).


## Desktop authorization and Keychain

`authorizeGoogleAccount` opens the system browser for an explicit selected email and service list. It binds a random PKCE verifier and one-use state to an ephemeral 127.0.0.1 listener, accepts only the matching callback, and expires after five minutes. It rejects missing offline grants, unverified or different accounts, write scopes, and unselected service scopes. Errors do not include token or provider response bodies. This follows [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app).

`MacGoogleCredentialStore` stores credentials in generic-password records under the fixed service `com.manas.google.oauth.v1`. It sends bounded base64 chunks over the Security CLI's stdin, verifies readback, then publishes a small generation pointer. Secrets never enter process arguments, Git, or operational SQL. Reads verify the complete generation hash and account identity. Successful updates clean the previous generation; a crash during chunk publication or cleanup can leave unreachable Keychain items that require later maintenance. Pointer removal withdraws access before cleanup.

Use this store only under the runtime's exclusive ownership lock. The current tests inject a Keychain runner and exercise chunk boundaries, corruption, interrupted publication, and pointer removal. A real macOS Keychain smoke test and the setup command wiring remain required before claiming an operational connector.

The account-bound client verifies account and service grants on every credential read, serializes refreshes, persists refreshed credentials before use, and checks source authorization before and after responses. Keychain compare-and-replace rejects stale refreshes after newer consent or disconnect. The persistence journal also accepts an authorization guard and checks it before canonical writes and checkpoint changes. Setup and job handlers must supply that guard.

## Source catalog and queue

After an owner has authorized an account and stored its credential, use `manas google add --input <json>` with a `boundary` object, `manas google status`, and `manas google sync --input <json>` with `id`, `expectedRevision`, and an `idempotencyKey`. Registration validates the selected account and service scope; repeating an identical boundary preserves its source ID. These local owner operations are excluded from delegated agent access. Status reports partial/full/delta scan state without exposing OAuth credentials or sync tokens.

The `google-source-sync` runtime handler reads one page per job. It checks tenant, brain, source revision, job attempt, cancellation, and active leases before writes. One operational transaction commits the cursor, projection job, page receipt, and continuation job. A retry after that transaction reuses the receipt and performs no additional fetch. Per-page runtime is bounded to two minutes, and `maximumPages` (1–1000) bounds a scan chain. Reaching that budget exposes `budgetExhausted` and retains the cursor for an explicit subsequent run. Retryable API delays are honored by the shared queue; permanent API failures stop the job.

Use the owner-only `google.sources.enable` catalog operation (`manas google enable`) with `id`, `expectedRevision`, `enabled`, and an `idempotencyKey` to pause or resume ingestion. A state change rotates the source revision; disabling cancels pending/running source jobs and clears its lease. Re-enabling preserves the checkpoint but requires a new sync request using the returned revision. Durable mutation receipts replay the original result without repeating the state change. A replay is explicitly marked and may describe a historical state after a later owner change. Re-registering the same boundary returns its current revision and never re-enables it implicitly.

## Connect an account

Create a Desktop app OAuth client in Google Cloud and enable the selected Gmail, Calendar, or People APIs using [Google’s desktop setup instructions](https://developers.google.com/identity/protocols/oauth2/native-app). Download its client JSON to a regular file owned by your macOS user; the file must not be writable by a group or other users. Manas reads the file locally and does not put its client secret in command arguments or catalog output.

For example, connect an explicitly bounded Gmail inbox:

```sh
manas google connect --repo /absolute/path/to/brain --input '{
  "clientFile": "/absolute/path/to/desktop-client.json",
  "email": "you@example.com",
  "boundaries": [{
    "service": "gmail",
    "visibility": ["personal"],
    "labelIds": ["INBOX"],
    "after": "2026-01-01T00:00:00Z",
    "before": "2027-01-01T00:00:00Z",
    "includeSpamTrash": false
  }]
}'
```

Calendar selections use `service`, `visibility`, `calendarId`, `timeMin`, and `timeMax`. Contacts selections use `service`, `visibility`, `groupIds`, and `allContacts`; choose explicit groups or set `allContacts: true` with an empty group list. Account IDs are assigned only after Google verifies the selected email.

The browser consent flow lasts up to five minutes. The local-socket client allows six minutes for this operation and sends authenticated cancellation on timeout or explicit cancellation. The service aborts active requests during shutdown. No ingestion starts during connection; use the returned source ID and revision with `manas google sync`. Reconnect with every previously connected service to preserve its grants. A failed or inaccessible Keychain blocks registration. If credentials are saved but the registration transaction fails, they remain in Keychain for a retry; no source is partially registered.

Setup tests use simulated consent and an injected credential store. A real Google consent session and macOS Keychain smoke test remain required for installation verification.

## Recurring ingestion

Use `manas google schedule --input <json>` with `id`, `expectedRevision`, `intervalSeconds` (60–86400), `enabled`, and an `idempotencyKey`. Optional `maximumPages` bounds each scan chain, and `runImmediately: true` makes the first poll due now. The schedule and mutation receipt persist together; retries replay the original result without moving its clock again. `manas google status` includes each source’s schedule and next run time.

The service worker materializes one overdue run after downtime and advances to the next future interval. It coalesces a poll when a scan for the same source revision is already pending or running. This prevents duplicate scans while long paginated ingestion continues. Competing scheduler transactions lock each source before its schedule and recheck current state, matching owner controls and preventing duplicate materialization or a disable race.

Pausing a schedule stops future polls and allows its current scan to finish. Disabling the source cancels its active ingestion jobs and disables its schedule. Re-enabling a source preserves its cursor but leaves scheduling paused; configure a schedule with the new revision to resume polling. A stale schedule is disabled automatically. Recurring ingestion requires the local service to be running. The [macOS service installer](macos-service.md) keeps it running across logins and process exits; a real login/restart smoke test remains required on a target Mac.

For an explicit native macOS storage check, run `bun run scripts/verify-native-keychain.ts --synthetic`. It uses unique synthetic credentials, verifies storage/read/replacement/removal, and confirms every task-created pointer and chunk is absent after cleanup. It does not read existing Keychain entries or contact Google. The [recorded check](native-keychain-verification.json) passed with a 7,000-character synthetic access token and 11 task-owned entries across two generations. This verifies the native storage protocol; real OAuth consent and account-bound ingestion still require the setup flow and selected ingestion boundaries.
