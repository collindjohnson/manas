# Agent integration

Manas ships five skills for recall, authorized capture, correction, grounded answers,
and maintenance. Skills are embedded in the built executable.

```sh
manas --config /absolute/path/manas.json agents preview codex
manas --config /absolute/path/manas.json agents install codex
manas --config /absolute/path/manas.json agents status codex
manas --config /absolute/path/manas.json agents verify codex --query "Juniper"
manas --config /absolute/path/manas.json agents uninstall codex
```

Use `claude-code` for Claude Code. `--home <directory>` selects a test home or
another explicit installation root. Existing `agents start|update` and
`agents status --input <JSON>` execution commands remain available.

Codex skills go in the user agent skills directory and hooks in the user Codex
hooks JSON file. Claude Code skills go in its user skills directory and hooks in
its user settings JSON file. The installer merges SessionStart and
UserPromptSubmit command groups, retaining unrelated hooks and settings.
Installation receipts and original hook settings are stored under
`stateRoot/agent-integrations`, outside the Git brain.

Preview reports skill conflicts before installation. Manas refuses to overwrite
unowned skills, including an identical file without its ownership receipt.
Uninstall removes matching owned skill files and exact owned hook groups.
It preserves edited files and hook groups. Empty skill directories may remain.
Symlinked installation parents are rejected, apart from standard macOS system
directory aliases.

Start the configured local service before using context hooks. Hooks use lexical
retrieval with a 1.5 second retrieval budget and a 1.75 second socket deadline.
The installed command has a two second timeout. Output contains at most about
2,000 tokens of cited context. A stopped or unavailable service produces an empty
hook result. Hooks request public evidence by default; explicitly selected labels can expand that grant. They never open a
standalone PGLite database. Context hooks skip embedding and reranking inference;
all capture model work runs in the worker.

Codex requires the user to review and trust non-managed hook definitions through
`/hooks`. Installing configuration does not grant trust. Status therefore keeps
configuration installation, hook trust, and real-session verification separate.
Status includes recent hook invocation receipts and actionable failures.
`agents verify` launches the selected native client under its normal hook trust
policy, with external tools disabled, and checks an exact citation against the
service plus a matching new UserPromptSubmit session receipt. It requires an
intact installation matching the active native configuration directory, a running service, native client sign-in, and a
query with evidence visible to the installed grant. It never bypasses trust.
Codex uses an ephemeral session; Claude Code retains a normal verification session
so its configured Stop hook can read the transcript.

A successful check sets `hooks.integrationObserved` and records the native
version, check time, definition hash, and hashed session ID outside Git. It does
not retain the query or answer. `hookTrust: observed-at-verification` describes
that invocation; it does not assert that trust cannot later be revoked. Capture
verification remains separate. Changed configuration, edited hooks, reinstall,
uninstall, or a failed new native verification invalidate the current proof.
Concurrent checks for one installation return a retryable error. The skills
component reports `verificationScope: skills-only`; native evidence is reported
under hooks. Receipts
retain hashes of session and turn IDs, outcomes, and timestamps, without prompt
text. An observed hook invocation is distinct from a verified real-agent session.
The [native Codex smoke report](native-codex-verification.json) verifies real
Codex 0.163.0 sessions with exact cited prompt-hook context, exclusion of private
evidence, opt-in Stop capture through the service worker and local Qwen model,
and authorized MCP writes with idempotent replay and recall. Fixtures use a
disposable brain and transient configuration. A reviewed, one-run hook trust
override does not establish persistent installation trust or verify a different
installation. Normal installation still requires `/hooks` review.

Run the explicit native check with:

```sh
bun run scripts/verify-native-codex.ts --run-native --run-native-hooks --run-native-capture --report docs/native-codex-verification.json
```

The automatic capture check requires local `qwen3.8:27b` at loopback Ollama.
The hook check fails closed when inherited user hooks differ from the reviewed
source hashes. Native MCP verification transiently approves only the two memory
tools. It does not change persistent agent settings or trust.

Claude Code 2.1.220 passes [native cited context and MCP capture](native-claude-local-verification.json)
using local `qwen3.8:27b` through the documented
[Ollama integration](https://docs.ollama.com/integrations/claude-code).
[Native Stop capture](native-claude-capture-verification.json) also passes, including
stable native identities and duplicate Stop delivery against the actual transcript.
The capture fixture uses the documented `CLAUDE_CONFIG_DIR` to keep configuration
and session history in a disposable installation. These checks do not verify a
Claude subscription session. Subscription authentication is expired, recorded
in [the authentication check](native-claude-authentication-check.json). After
`claude auth login`, account-backed verification can run with:

```sh
bun run scripts/verify-native-agent.ts claude-code --run-native --report docs/native-claude-verification.json
```

For explicit local inference instead, add `--local-model qwen3.8:27b` and save to
a separate report. The script checks prompt context and explicit MCP capture.
Run the separate native capture check with:

```sh
bun run scripts/verify-native-claude-capture.ts --run-native --verify-installation --report docs/native-claude-capture-verification.json
```

The local mode uses loopback Ollama with no fallback and leaves account credentials
and persistent user configuration unchanged. `--verify-installation` additionally
runs the production `agents verify` command under normal Claude hook policy.
It creates a verification session within the disposable configuration directory.
For an existing custom Claude installation, the active `CLAUDE_CONFIG_DIR` must
match `--home <directory>/.claude` before verification. The verifier reads an
existing Codex home setting; it does not change it. Automated service tests cover both
agents, repeated delivery, restart recovery, capture withdrawal, and revoked
grants; those tests do not replace native session verification.

Automatic capture is disabled by default. Install with `--capture` to
enqueue extraction at Stop. Codex stages user prompts with session and turn IDs.
Claude Code reads the selected local session transcript in bounded background
pages and uses user-message UUIDs as stable turn IDs. Only user messages dated
after opt-in are eligible; assistant, tool-result, synthetic, and metadata records
are excluded. Incomplete final lines are reconsidered on the next Stop.
Disabling and re-enabling capture creates a new grant epoch and revokes old work. The default capture visibility is `["personal"]`; select another
grant with `--visibility <JSON-array>`. The same labels apply to context delivery.
Reinstalling without `--capture` disables capture. Uninstalling revokes it,
including pending work.

The worker uses the configured local generation model, extracts at most ten
verbatim spans from a bounded user prompt, and validates every source offset.
Assistant-generated answers are excluded. Extraction checkpoints precede Git
writes, and stable turn/span keys deduplicate retries. Jobs retain source hashes
and write receipts; inspect `jobs list` for failed or pending capture.
Missing local models produce a visible job failure with a configuration fix.
The service and `jobs run-one --repo <brain> --store <state>` use the same
`jobs.run-one` catalog operation, providers, and worker handlers. A manual worker
command connects to a running service instead of opening its PGLite store.
Capture does not resurrect a withdrawn memory.

Agent installation also merges an owned `manas` MCP entry into Codex
`~/.codex/config.toml` or Claude Code `~/.claude.json`. Preview shows its command,
arguments, and selected grant. Existing unowned entries cause a conflict; use
`--no-mcp` to install only skills and hooks around separately managed MCP.
Install and uninstall require an explicit `--config`.

The managed connection defaults to read-only operations. Add `--write` during
installation for authorized memory writes. `--visibility '["personal"]'` grants
selected labels; capture defaults to the personal label. Owner administration
and legacy aliases are excluded. Grants are checked on every request and before
returning a result. Uninstall revokes the grant even if edited MCP settings are
preserved. Reconnect after increasing scope to discover newly available tools.

Generic MCP remains available through `serve --scope read`, with optional
`--visibility` and `--scope write`. An unscoped local stdio connection retains
owner compatibility.

Official integration contracts:
[Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Codex skills](https://developers.openai.com/codex/skills),
[Claude Code hooks](https://code.claude.com/docs/en/hooks).
