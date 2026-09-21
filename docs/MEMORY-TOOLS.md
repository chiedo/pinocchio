# Agent memory tools and enrollment

This development integration adds memory tools to the configuration-bound
identity and SQLite store. [Optional local semantic retrieval](SEMANTIC.md) is
available behind the same search tool. This is not an installer
or replacement for native host memory/model settings. Use the pinned public
CLI 1.0.83 and Node 22.18.0 baseline; other hosts/platforms remain unadvertised.

## Architecture and trust

Each enrolled profile receives its own explicitly bound MCP server exposing
`agent_memory_search`, `agent_memory_save` and a metadata-only `identity_status`.
Owner and repository/global scope come exclusively from the existing immutable
binding, never tool arguments or the selected foreground agent.

A separate shared context extension uses the public `onUserPromptSubmitted`
and `onPreMcpToolCall` hooks. The host supplies root-session and actual recipient
session IDs (including helper instances). Prompt timestamps define request
boundaries. The pre-MCP hook replaces request metadata with a short-lived,
HMAC-authenticated ticket binding root, recipient, request, call, server, tool,
arguments and deadline. Missing, altered or stale tickets fail closed. An MCP
transport session or process ID is **not** treated as a conversation ID.
SDK integrations must enable the root hook capability on **both create and
resume** (by supplying a lifecycle hook), request extensions, and initialize
the extension/tool catalog before dispatch. On the pinned baseline, resuming
without root hooks can reject extension registration with `Hook processor is
not configured`; it is not a successful memory resume. The public-host gate
records session-start/resume events through a root lifecycle hook and uses the
production extension for all accounting and ticket issuance.
Tickets also bind the host's working directory. A repository-scoped server checks
its canonical Git root against that directory before opening memory, so using an
enrolled user profile from another repository cannot expose the pinned repository's
notes. Global bindings remain intentionally independent of the working directory.

The context ledger and signing key live privately under
`<config-root>/pinocchio/context/`. Only hashed execution IDs, request timestamps,
usage counters and delivered record/revision IDs are stored there: no prompt,
query or recalled note text. Back up this directory together with private stores
when preserving ongoing sessions. Do not delete it to reset an active session's
request allowance. Filesystem access by the same user is not an OS security boundary.
The extension also registers `pinocchio_memory_context_status`, a bounded,
content-free service-health diagnostic. It does not select an owner or expose
session identifiers, usage history or notes.

Blocking SQLite and identity/file work run in worker threads, outside MCP
dispatch. Each bound MCP server initializes its worker before connecting, with
a separate five-second startup limit, so the first tool call does not pay for
cold module loading. A context extension and each bound MCP process own a worker;
this is not an always-running daemon. Each worker has one active operation and at most
eight queued operations. A one-second deadline starts at the pre-MCP hook and
includes context issuance, queueing, any worker restart, and identity checks.
Late responses are discarded and the timed-out worker is terminated. Contention and worker
failures are explicit, never disguised as no match.

## Bounds and persistent accounting

| Limit | Enforcement |
|---|---|
| Search response | At most three snippets and 800 conservative memory-token units |
| Recipient request | At most 800 units across repeated calls and agent namespaces |
| Root session | Cumulative usage is recorded, but does not disable later requests |

One charged unit is one UTF-8 byte of the serialized snippet array, including
record IDs, evidence kinds and dates. This deliberately conservative byte bound
does **not** claim model-specific tokenizer precision or promise 800 tokens of
useful text. It avoids guessing a characters-per-token ratio as models change.
Small status/budget metadata outside the snippet array is not memory content.

Delivery deduplication keys include root session, actual recipient, request,
visibility generation, namespace, scope, record ID and exact revision.
Another helper instance pays for its own delivery. Reload/resume preserve both
deduplication and counters. Compaction invalidates visibility (conservatively for
the entire root session) but never resets the request allowance; any redelivery is
charged again. A new request resets only that recipient's request allowance.
A new root session starts a new cumulative usage counter. Foreground and helpers
each retain their request bounds; there is no aggregate lifetime cap across them.
Long-running conversations can therefore keep retrieving small results.

Responses report `requestRemaining` and cumulative `sessionUsed` in byte-based
units. `sessionUsed` replaces the old `sessionRemaining` field; it is diagnostic,
not an allowance. Existing ledgers need no migration or reset. `budget_exhausted`
now reports `budgetScope: "recipient_request"` and means the current request has
too little room for another result, not that later requests are blocked. A new
host prompt renews the recipient request on the hook-driven path.

On the extension/direct-MCP fallback paths, a request is currently one tool call,
not a verified user turn. Those paths retain the 800-byte call limit and no
longer stop after 6,000 cumulative bytes. This change does not claim to make
fallback accounting turn-aware or provide an aggregate helper budget.

Search and accounting commit while holding a validated memory snapshot, so
corrections, forget and disable cannot race an unchecked result. Accounting may
conservatively charge a result that was committed but whose delivery was lost;
failures never refund guessed delivery or permit an over-budget retry.

## Tool behavior

Actual host tool names are prefixed with the bound MCP server's name. Enrollment
writes those exact names into the profile's tool list and instruction block.

`agent_memory_search({query})` returns `ok` with bounded snippets, or explicit
`no_match`, `already_delivered`, `budget_exhausted` or `unavailable` status.
Snippets include record ID, revision, memory kind, evidence kinds,
source/confirmation dates and recording date. They remain historical evidence,
not higher-priority instructions.

Both the extension's `pinocchio_memory_search` and MCP's `agent_memory_search`
accept recent-history requests without topic keywords:

```json
{"mode":"recent","since":"2026-05-12T13:45:00Z","before":"2026-05-12T14:00:00Z"}
```

Recent mode reads captured conversations by source timestamp, newest first:
`since` is inclusive and `before` is exclusive. The maximum window is 30 days;
omitting `before` uses now and omitting `since` uses 30 days before the end.
Explicit bounds should be used for calendar periods and ambiguous date phrases.
Offsets are normalized to UTC. Query keywords are ignored in this mode.
Only active/tentative captures in the bound agent scope qualify, not curated
notes, forgotten/superseded entries, or messages from the requesting session.
The direct-MCP fallback cannot identify a real host session and can only exclude
its synthetic process session. Results remain partial, subject to the existing
three-snippet/800-byte cap; evidence labels and timestamps are preserved.

Simple query-only recaps such as "What did we just discuss?" or "What did we
discuss in the past 15 minutes?" also select recent mode. Numeric minute/hour/day
windows and an optional `before <ISO timestamp>` anchor are recognized. Automatic
prompt recall detects these questions before removing filler words, so the first
response can use recent history without a model tool call. This is deliberately
not a general natural-language date parser. Set `mode:"topic"` to force topic search.

Topic tool queries ignore common English filler words, prefer literal/all-term
matches, then fall back to ranked word overlap if no exact match exists.
Fallback requires at least two meaningful query words, avoiding unrelated
results that share only one generic word. Single-term searches still work normally.
Optional semantic retrieval is unchanged. The administrative storage CLI keeps
its exact-search semantics for precise inspection and deletion checks.

`no_match` remains distinct from budget exhaustion. `reason` is
`NO_CAPTURED_CONVERSATION_IN_WINDOW` for empty recent history and
`NO_MATCHING_MEMORY` for an empty topic search. No retained capture does **not**
prove no conversation happened: capture may have been paused, unavailable, or
pruned. This change neither backfills transcripts nor changes retention.

`agent_memory_save` supports these strict argument shapes:

```json
{"action":"remember","operationId":"example-save-1","note":{"content":"Synthetic cobalt identifier ABC-123","kind":"fact","evidence":[{"kind":"manual_entry","reference":{"type":"text","value":"invented example"}}]}}
```

```json
{"action":"correct","operationId":"example-correction-1","recordId":"00000000-0000-4000-8000-000000000001","expectedRevision":1,"note":{"content":"Synthetic corrected identifier ABC-456","kind":"fact","evidence":[{"kind":"manual_entry","reference":{"type":"text","value":"invented correction"}}]}}
```

```json
{"action":"status","operationId":"example-save-1"}
```

A save returns `committed` only after SQLite commit. Definite failures return
`save_failed` with a fixed code; stale corrections include the current revision.
A deadline, cancelled call or lost worker can leave `outcome_unknown`. Resolve
using `action: "status"` or retry the identical payload and operation ID in a
valid request. Never generate a new operation ID merely because an
acknowledgement was lost. The local [storage CLI](STORAGE.md) remains available
for recovery without a model context.

## Development enrollment

Build first with `npm ci && npm run build`. Register an immutable binding using
[BINDINGS.md](BINDINGS.md). Then, in Bash, substitute that registration's values:

```bash
node dist/src/enrollment-cli.js enroll \
  --config-root "$CONFIG_ROOT" --binding "$BINDING_ID" --fingerprint "$FINGERPRINT"
```

Enrollment first launches the bound server, verifies both tool schemas and its
identity/capability response, then adds the profile's MCP configuration, tool
names and a versioned instruction block. It also prepares a development context
extension under the chosen config root, pointing at this checkout's compiled
runtime. **Restart/reload the host before using the enrolled profile.** A missing
context extension makes memory visibly unavailable; it never falls back to
unscoped calls.

This is source-checkout setup, not portable installation: moving/deleting the
checkout breaks its absolute runtime reference. Keep runtime, profiles and
private memory outside public commits. Existing nonmatching context-extension
files are not overwritten.

Existing profiles must have a YAML `tools` list. Pinocchio preserves Copilot's
global `*` and server-scoped wildcard entries such as `computer-use/*`. A global
wildcard already includes Pinocchio's extension tools, so enrollment does not
add redundant entries; narrower lists receive explicit managed tool entries.
Profiles without a tools list or with malformed wildcard patterns are refused
rather than silently replacing their access. Project/shared and plugin
definitions additionally require
`--allow-shared`; no shared profile is silently enrolled. Native model and
reasoning settings, unrelated frontmatter, comments and body instructions are
preserved; YAML formatting may be normalized.

Create a new explicitly scoped profile through the helper:

```bash
node dist/src/enrollment-cli.js create --config-root "$CONFIG_ROOT" \
  --definition "$AGENT_ROOT/example.agent.md" --origin-root "$AGENT_ROOT" \
  --name example --repository "$REPOSITORY"
```

The parent directory must exist. The helper refuses existing files, creates a
minimal profile with `view` access and no model override, registers it and enrolls
memory. Use `--global` instead of `--repository` only for intentionally global
memory. A failed setup reports an error; any newly created profile/registration
is left inspectable rather than silently deleted.

Refresh an existing profile's generated guidance after updating Pinocchio:

```bash
node dist/src/enrollment-cli.js refresh \
  --config-root "$CONFIG_ROOT" --binding "$BINDING_ID" --fingerprint "$FINGERPRINT"
```

For agents created with `npm run setup`, rerun that original setup command instead.
The managed block now includes the agent's filename-based ID, exact profile path,
memory scope, and configuration/editing guidance. Refresh accepts the original
memory-only block and the current block, preserving all bytes outside it. It is
idempotent, keeps the same binding and memories, and still requires `--allow-shared`
for project/plugin profiles. Modified managed content is a conflict, not an
invitation to overwrite. Restart the host to load the refreshed profile.

Remove managed enrollment without deleting notes:

```bash
node dist/src/enrollment-cli.js remove \
  --config-root "$CONFIG_ROOT" --binding "$BINDING_ID" --fingerprint "$FINGERPRINT"
```

Removal deletes only its exact managed instruction block, bound server and two
tool entries. Later unrelated edits survive. Modified managed sections cause an
explicit conflict instead of overwriting user changes. The shared context
extension stays because other agents may still use it. Records and accounting
stay intact; scoped disable/forget remain separate local administrative actions.

Enrollment is governed by local permissions, not proof a human typed the
command. Instructions encourage search/save but do not force model calls,
continuation, orchestration, summarization or changes to native memory settings.

## Verification and remaining work

Run `npm run typecheck && npm test` in CI or an isolated development environment.
The synthetic suite covers authenticated context, per-recipient/session limits,
worker restart, compaction accounting, queue/deadline failures, scoped saves,
enrollment preservation and real public-host foreground/helper behavior.
Explicit save/recall/delete gates pause automatic capture only for their synthetic
bindings so conversation snippets cannot consume those assertions' request budgets.
A separate native-host gate leaves automatic capture enabled and verifies cold-session
recall without model memory calls, cross-agent isolation, and pause behavior.
Normal CI uses no paid model calls. Only aggregate reports may be uploaded.

Live-model compliance/quality evaluation, release
packaging and desktop validation remain separate gates. Synthetic tool execution
does not prove a real model will always choose to recall or save.
