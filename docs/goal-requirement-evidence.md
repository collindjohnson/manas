# Requirement evidence for the gbrain gap plan

This audit maps the requested implementation to executable evidence. Tests refer to files under `tests/`; implementation paths are relative to the repository root. A passing fixture establishes the behavior exercised, not universal model quality or deployment to an owner account. The verification snapshot and native report versions are in [the completion audit](goal-completion-audit.md).

## Runtime, migration and baseline

| Requirement | Implementation | Verification |
| --- | --- | --- |
| One configured runtime, providers, authorization and citation policy across CLI, MCP, hooks and jobs | `src/canonical-runtime.ts`, `src/canonical-services.ts`, `src/brain/operation-registry.ts`, `src/brain/runtime-jobs.ts` | `memory-transport.test.ts`, `operation-transport-contract.test.ts`, `runtime-jobs.test.ts`, `cli-config-routing.test.ts` |
| Authenticated local socket, exclusive PGLite/queue ownership and standalone fallback | `src/local-service.ts`, `src/brain/ownership.ts` | `local-service.test.ts`, `store-ownership.test.ts`, `serialized-store.test.ts`, concurrent client cases |
| Git authority; rebuildable projections; durable external operational state | `src/brain/repository.ts`, `src/brain/store.ts`, `src/canonical-runtime.ts` | `projection-contract.test.ts`, `database-migrations.test.ts`, `runtime-backup.test.ts` |
| Versioned config and resumable archive migration preserving IDs, transcripts, timestamps, provenance and user edits | `src/config.ts`, `src/archive-migration.ts`, `src/identifier-migration.ts` | `config-loader.test.ts`, `archive-migration.test.ts`, `identifier-migration.test.ts`, commit/checkpoint crash and exact-byte cases |
| Hash/retrieval comparison, shadow reads, explicit cutover and rollback without deleting archives | `src/archive-migration.ts`, `src/canonical-runtime.ts` | `canonical-runtime.test.ts`, `migration-ownership.test.ts`; operator migration is deliberately not activated by verification |
| No automatic hosted or command generation fallback; lexical retrieval without models | `src/brain/local-inference.ts`, `src/brain/providers.ts`, `src/brain/search.ts`, `src/brain/synthesis.ts` | `local-inference.test.ts`, `local-provider-redirects.test.ts`, `providers.test.ts`, `brain-retrieval.test.ts`; retained legacy configuration is inert |
| Actual fixed-corpus baseline before ranking changes | `scripts/evaluate-retrieval.ts`, `src/brain/lifecycle-evaluation.ts` | `lifecycle-evaluation.test.ts`, retained baseline and development/held-out result artifacts; metrics derive from executed retrieval |

## Memory and grounded answers

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Persisted remember, recall, correct and forget through CLI, MCP and TypeScript | `src/brain/memory.ts`, `src/brain/operation-catalog.ts`, `src/index.ts` | `memory.test.ts`, `memory-transport.test.ts`, `public-api.test.ts` |
| Stable IDs, provenance, validity, visibility, status, supersession, revision checks and idempotency | Git memory records and operation inputs in `src/brain/memory.ts` | `memory.test.ts`, `repository-fault-injection.test.ts`, repeated-write/revision-conflict cases |
| Correction preserves history; withdrawal suppresses retrieval, extraction, context and maintained answers after rebuild | Memory lineage, current evidence validation and retrieval filters | `memory.test.ts`, `context-delivery.test.ts`, `memory-capture.test.ts`, `maintained-answers.test.ts`, `lifecycle-evaluation.test.ts` |
| Owner history remains accessible; forgetting accurately means withdrawal from ordinary use | Owner-authorized history and lifecycle responses | `memory.test.ts`, `scoped-client-registry.test.ts`; Git history is retained |
| Shared document/revision/commit/span/scope evidence; local generation, validated citations and explicit insufficient evidence | `src/brain/reasoning.ts`, evidence validation in catalog/runtime | `reasoning.test.ts`, `operation-transport-contract.test.ts`, `security-drills.test.ts`, recorded local answer evaluation |

## Codex and Claude Code

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Recall, capture, correction, grounded answer and maintenance skills | Embedded agent skills and skill installer | `skills.test.ts`, `agent-management.test.ts`, `bun run skills:check` |
| Preview/install/status/uninstall preserve unrelated configuration and track owned changes | `src/agent-management.ts`, `src/agent-hooks.ts`, agent MCP installer | `agent-management.test.ts`, `agent-hooks.test.ts`, `agent-mcp.test.ts` |
| Supported start/prompt hooks, two-second request deadline, approximately 2,000-token response and fast unavailable behavior | `src/brain/context-delivery.ts`, hook client | `context-delivery.test.ts`, `agent-hooks.test.ts`; real native context reports for both clients |
| Opt-in Stop capture enqueues session/turn IDs, exits before model work and deduplicates | `src/brain/memory-capture.ts`, Claude transcript capture, runtime queue handlers | `capture-service.test.ts`, `claude-transcript-capture.test.ts`, `memory-capture.test.ts`; real native Stop reports for both clients |
| Installed, trusted and observed states remain separate; Codex explicit trust respected | `src/agent-verification.ts`, `src/agent-verification-state.ts`, hook status | `agent-verification.test.ts`; actual Claude normal-policy verification passes; Codex native fixture uses documented one-run reviewed-source trust override and does not establish permanent trust |
| Generic MCP remains available with scoped access | `src/mcp/server.ts`, `src/mcp/http.ts`, operation registry | `mcp-stdio.test.ts`, `mcp-http.test.ts`, `mcp-catalog-boundary.test.ts`, `scoped-client-registry.test.ts` |

## Relationships, maintained answers and feedback

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Typed evidence-backed relationships, aliases, confidence, validity and ambiguous merge review | `src/brain/entity-relationships.ts`, entity review operations | `entity-relationships.test.ts`, `entity-review.test.ts`, `maintenance-relationships.test.ts` |
| Bounded two/three-hop planning with authorization throughout and cited relationship chains | Relationship planner/traversal and source revalidation | `entity-relationships.test.ts`, `security-drills.test.ts`, lifecycle held-out fixtures; deterministic planning tests do not establish broad model reasoning quality |
| Git pinned definitions; external answer caches; evidence/expiry/permission invalidation; queued refresh | `src/brain/maintained-answers.ts`, runtime jobs | `maintained-answers.test.ts`, `runtime-jobs.test.ts` |
| Generated answers excluded from primary evidence and automatic fact extraction | Primary-evidence classification and maintenance filters | `maintained-answers.test.ts`, `maintenance-scan.test.ts`, `meeting-preparation.test.ts` |
| Ratings bind answer ID and exact revisions, deduplicate, reset and do not influence ranking | Feedback operations and durable receipts | `maintained-answers.test.ts`, `operation-catalog.test.ts`; influence remains disabled |

## Ingestion and automation

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Official read-only Gmail/Calendar/Contacts OAuth; macOS Keychain; explicit accounts and boundaries | `src/sources/google-oauth.ts`, `google-api.ts`, `google-keychain.ts`, `src/brain/google-setup.ts` | Google OAuth/authorization/setup/account-client/Keychain tests; native Keychain verification; no owner Google consent or ingestion claimed |
| Pagination, durable incremental cursors, retry ledgers, successful-persistence checkpoints and expired-cursor reconciliation without history deletion | `src/brain/google-sync.ts`, `src/brain/google-jobs.ts` | `google-sync.test.ts`, `google-jobs.test.ts`, `google-account-client.test.ts`; crash between persistence/checkpoint, expired cursors, pagination failure and revoked access |
| Session ingestion uses the same durable checkpoint discipline; late records are not skipped | `src/sources/conversations.ts`, conversation ingestion and source checkpoints | `conversation-ingestion.test.ts`, `conversation-source.test.ts`, `source-sync.test.ts`, `checkpoint.test.ts` |
| Substantive incremental extraction, relationships, contradictions, duplicate proposals, stale evidence and pinned refresh | `src/brain/maintenance-scan.ts`, maintenance extraction/assertions/contradictions/proposals | `maintenance-scan.test.ts`, `maintenance-window-recovery.test.ts`, `maintenance-relationships.test.ts`, `runtime-jobs.test.ts`; recorded local model maintenance evaluation |
| Meeting preparation retrieves participants, recent interactions and commitments; cited open loops/status; local notifications and UI | `src/brain/meeting-preparation.ts`, open-loop and reminder operations, `src/owner-ui.ts` | `meeting-preparation.test.ts`, `open-loops.test.ts`, `reminders.test.ts`, `owner-ui.test.ts`; visible OS delivery remains unobserved |
| Durable execution steps/results, cancellation, lease renewal, retries and item/token/runtime budgets | `src/brain/catalog-execution.ts`, `src/brain/jobs.ts` | `catalog-execution.test.ts`, `jobs.test.ts`, `job-policy.test.ts`; store reopen, lease loss, partial progress and budget accounting |
| Catalog-only execution; proposals by default; bounded opt-in writes to owned content; risky changes reviewed | Execution allowlist, maintenance approval and owner settings | `catalog-execution.test.ts`, `maintenance-scan.test.ts`, `entity-review.test.ts`; managed writes are not enabled for the owner by tests |

## Administration, devices and recovery

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Same-origin setup/model health/source freshness/memory/pin/proposal/job/client UI | `src/owner-ui.ts`, `src/owner-ui/` | `owner-ui.test.ts`; desktop/mobile browser inspection and retained mobile image; model setup documents local provider configuration |
| Owner administration separated from client access; tenant/brain/visibility enforced across all surfaces | Operation registry, scoped-client predicate, evidence validation, owner sessions | `scoped-client-registry.test.ts`, `tenancy.test.ts`, `rls.test.ts`, `security-drills.test.ts`, cache/context/graph/reminder tests |
| Owned macOS service installation, startup recovery, health and missed-work coalescing | `src/service-installation.ts`, `src/scheduler-activation.ts`, runtime scheduler | `service-installation.test.ts`, `scheduler-activation.test.ts`, `scheduler-receipt.test.ts`; native launchd bootstrap, forced-crash restart and persistence pass; logout/login and actual sleep are not exercised |
| Optional selected-device Tailscale Serve; explicit Funnel; preserve unrelated configuration | `src/device-access.ts`, `src/device-installation.ts`, `src/device-service.ts` | Device access/install/service tests with real Unix service and injected Tailscale responses; native installed CLI contract inspected; no real second-device exposure activated |
| Consistent Git plus operational-state backup, clean restore, rebuild and excluded-credential reconnection | `src/runtime-backup.ts`, backup operations and restore fences | `runtime-backup.test.ts`, `backup.test.ts`, `fresh-install.test.ts`; hash corruption, live owner, unsafe destination, restored withdrawal and revoked credential/session cases |

## Public contract and rollout

The schema-backed catalog is exercised by `operation-catalog.test.ts`, `operation-registry.test.ts`, `operation-transport.test.ts` and `operation-transport-contract.test.ts`. Stable structured errors include code, retryability and suggested fixes while preserving MCP result conventions. Existing command/archive compatibility is covered by legacy, identifier migration, CLI, source conformance and public API tests. OS installation commands remain local owner actions.

Development and held-out retrieval gates measure recall@10, MRR and nDCG@10 separately from local-model quality/latency. Safety fixtures cover authorization, invalid citations, corrections, withdrawal after rebuild, stale caches, permission changes and repeated capture. Reliability fixtures cover persistence/checkpoint gaps, pagination, cursor expiry, duplicate delivery, leases, cancellation, concurrency and restoration. PostgreSQL contracts and both macOS binary checks are retained. Native Intel execution is enforced by its release CI runner and cannot execute on the current arm64 host.

The delivered rollout sequence remains baseline → backup/migration preview → shadow comparison → explicit canonical cutover → client installation/trust/verification → maintenance proposals → optional managed writes/device access. No test silently cuts over an owner archive, grants permanent trust, consents to an account, enables managed writes, or exposes a device. Legacy archives and migration receipts are retained for rollback.

The remaining live checks are environmental activation/observation: owner Google consent with selected boundaries, visible OS notification delivery, actual logout/login and sleep/resume, selected second-device connectivity, native Intel CI, and normal-policy verification after the owner trusts an installed Codex hook. They are explicitly unverified; fixture success must not be presented as those results.
