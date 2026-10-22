---
name: manas-correct
description: Correct or withdraw an authorized persisted Manas memory while preserving its history and respecting revision checks.
---

Recall the relevant memory to obtain its stable ID and current memory revision. Use `memory.correct` with id, expectedRevision, new text, provenance, and a new idempotencyKey. Corrections supersede the earlier assertion. Omitted visibility and validity fields retain existing values.

When the user asks to forget a memory, call `memory.forget` with id, expectedRevision, idempotencyKey, and an optional reason. Explain that withdrawal removes it from ordinary retrieval and maintained evidence; it does not erase earlier assertions from Git history. Withdrawn memories cannot be reactivated through correction. A new assertion requires explicit intent and new provenance.

On revision_conflict, recall the current revision and review whether the requested correction still applies. On a lost response, retry the identical request with the same key. On idempotency_conflict, do not silently substitute input. Owner-only `memory.history` provides explicit history inspection. CLI commands are `manas correct` and `manas forget`, each with `--input <JSON>`.
