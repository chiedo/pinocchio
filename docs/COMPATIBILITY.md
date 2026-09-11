# Memory compatibility gates

**Release certification:** use the separate [release evaluations](EVALUATIONS.md)
and versioned contract. Earlier component passes below are not a live-model
release verdict; missing authorized evidence remains explicitly unvalidated.

**Local semantic gate: PASS.** The [passing full-suite run](https://github.com/chiedo/pinocchio/actions/runs/34558833513)
passed 59 tests, including real CPU inference with the pinned quantized MiniLM
model and FAISS. On the fixed four-query paraphrase corpus, hybrid top-three
retrieval found 4/4 expected notes versus 0/4 for the unchanged keyword-only
baseline; the predeclared minimum was three hybrid hits and improvement over
keyword search. Exact-identifier retention and irrelevant-query rejection also
passed.

Recovery coverage verifies process-level builder exclusion, stale-publication
rejection, abandoned generations, corruption/model mismatch, source-revision and
scope checks, deletion cleanup, and real hybrid retrieval through the existing
budgeted model worker. The existing administrative search gains an explicit
`--hybrid` option; its default keyword baseline is preserved.

Only aggregate `test-results/semantic.json` is published. No paid inference,
notes, vectors or model files are uploaded. This small synthetic corpus is not
the live-model compliance, answer-benefit or p95 release certification required
by #6. See [SEMANTIC.md](SEMANTIC.md) for the pinned assets, resource bounds,
offline setup, degradation states and publication/cleanup protocol.

**Keyword-memory development gate: PASS on the pinned public host with root
hook capability enabled.** The [passing integration run](https://github.com/chiedo/pinocchio/actions/runs/34540221637)
uses actual enrolled native profiles, the production context extension and
bound MCP memory servers. It verifies foreground save/recall, independent helper
recall, rejected cross-agent calls, extension reload, cold resume with persistent
accounting, and a new root session recalling prior notes.

The public SDK harness must enable root hooks on create **and resume**, request
extensions, and initialize the extension/tool catalog. Without that capability,
the pinned host can reject cold-resume extension registration with `Hook processor
is not configured`. Shutdown explicitly detaches the extension connection.
This is a documented prerequisite, not an inferred identity fallback.

Worker-level synthetic cases additionally cover three-snippet/800-unit responses,
800-unit recipient requests, the shared 6,000-unit session cap, persisted dedup,
simulated compaction/redelivery accounting, signed argument/repository context,
queue/deadline failures, save recovery and reversible enrollment. Token charging
uses conservative serialized UTF-8 bytes, not claimed model-specific precision.
See [MEMORY-TOOLS.md](MEMORY-TOOLS.md) for exact limits and setup.

Only the aggregate `test-results/memory-workflow.json` is published. Real-model
compliance/quality, production installation and desktop
support remain unvalidated separate gates.

**Production identity gate: PASS for explicit configuration-bound MCP servers.**
The pinned public CLI/Linux baseline resolves canonical definition identities and
repository/global scopes through the production binding registry, including
revocation and lifecycle checks. The original shared extension still cannot infer
a trusted caller definition and remains fail-closed. Its historical NO-GO is not
the decision for the new architecture.

## Public baseline

| Item | Baseline |
|---|---|
| Public CLI | [1.0.83](https://github.com/github/copilot-cli/releases/tag/v1.0.83), released September 4, 2026 |
| Public SDK | [1.0.13](https://www.npmjs.com/package/@github/copilot-sdk/v/1.0.13); its package manifest pins CLI 1.0.83 |
| Runtime | Node.js 22.18.0, TypeScript, compiled ESM |
| Public-host execution | Configuration-bound production identity gate PASS on `linux-x64` |
| Supported surface | Identity diagnostics, SQLite administration and optional local hybrid memory on CLI 1.0.83 / Linux x64 with root hooks; no release, desktop or other-platform certification |

## Production identity gate

On September 10, 2026, the full synthetic suite passed, including **29/29
production public-host checks**, using the real `BoundIdentityAdapter`, private
registry and MCP SDK server, not the prototype protocol fixture.
[Measured CI run](https://github.com/chiedo/pinocchio/actions/runs/34533525350).
That run passed 24 tests; a subsequent removed-definition revocation regression
adds one test. The current complete suite is the reproducible source of truth.

| Requirement | Production evidence |
|---|---|
| Stable owner and origin | Three real synthetic definition files with the same basename, distinct project/user/plugin origins and distinct namespaces |
| Foreground and helpers | Matching registered identities in direct, model-generated and concurrent delegated calls |
| Repository/global boundaries | Separate bound tools return only their configured scope; the same definition retains its namespace |
| Unauthorized target | Direct and model-emitted cross-agent requests cannot return another registered identity |
| Edits and lifecycle | Prompt/display edits preserve identity; reload, warm resume and cold process restart preserve valid bindings |
| Stale binding | Live revocation, revoked scope after restart and altered launch fingerprints return unavailable, without identity data |
| Bounded failures | Adapter operations have a 900 ms budget; unit cases cover cancelled, missing, invalid, delayed and in-flight revoked work |
| Registry reliability | Private modes, symlink rejection, canonical aliases, concurrent registration, independent CLI processes and definition/repository replacement |
| No automatic orchestration | Normal MCP tools only; no profile mutations, model changes, hidden prompts or extra agents |

Observed timed production host calls in the linked run were **10-204 ms**,
including host dispatch. This is a small synthetic sample, not a p95 performance
guarantee. Only aggregate case results and timings are published in
`test-results/production-bindings.json`. The other reports preserve the original
shared-extension NO-GO and earlier fixture experiment; they are labeled separately.

See [BINDINGS.md](BINDINGS.md) for runnable registration/status/revocation commands,
custom roots, lifetime semantics and explicit host tool-allowlist requirements.
Automatic profile enrollment is deliberately deferred to issue #4. The
production binding metadata also scopes the separate local SQLite store. This
does not expose memory through the identity-only MCP diagnostic.

## Local storage verification

The [full synthetic CI run](https://github.com/chiedo/pinocchio/actions/runs/34537285277)
passed **38/38 tests**, including 12 storage tests and the existing identity
gates. A subsequent test executes the documented Bash example; the current
complete suite remains the source of truth.

| Storage boundary | Evidence |
|---|---|
| Durable transactions | Atomic note/evidence/revision/keyword/job/operation writes; restart and hot-journal recovery |
| Retry and concurrency | Independent-process competing writers, expected revisions, busy errors, idempotent replay and lost acknowledgement recovery |
| Correction/deletion | Old keywords disappear; every content revision is deleted; pending jobs cancel; retired operation IDs cannot resurrect content |
| Scope and controls | Same-named definitions, separate repositories/global scope, custom config root and persistent scoped disable/enable |
| Invalid state | Source failure and late index-job failure roll back; unsafe/replaced paths, revoked bindings, foreign owners and incompatible schemas fail closed |

See [STORAGE.md](STORAGE.md) for commands and migration/recovery boundaries.
No semantic retrieval, model-facing memory tools or worker latency certification
is implied. Storage fixtures and raw databases are never published as artifacts.

The compatibility probe requires the exact public runtime and SDK versions. It
launches the locked `@github/copilot` executable, not an ambient `copilot`,
private distribution or live user session. The SDK-only standalone runtime does
not provide the full CLI's extension launcher. The probe explicitly supplies
the unmodified, pinned public npm SDK's `dist/` directory as `extensionSdkPath`.
It checks both public versions rather than using the SDK from a local CLI
installation.

## Historical blocker: shared caller-metadata inference

The public SDK's `ToolInvocation` supplies `sessionId`, `toolCallId`, `toolName`,
arguments, optional cancellation and tracing metadata. It does **not** provide
an authoritative per-call binding to a stable agent definition, definition
origin, repository and lifecycle generation.

`AgentInfo` exposes selection IDs, optional paths and origins. `agent.getCurrent`
describes the selected foreground agent, not necessarily the caller of an
in-flight helper tool. Session events can expose an optional helper instance ID
and parent tool-call correlation. Those are useful observations, but do not by
themselves prove the complete definition/origin/freshness contract. Missing events
must not be interpreted as evidence of a foreground caller.

Source references are the public package's `dist/types.d.ts` (`ToolInvocation`),
`dist/generated/rpc.d.ts` (`AgentInfo`, `agent.getCurrent`) and
`dist/generated/session-events.d.ts` (`SubagentStartedData`,
`ToolExecutionStartEvent`). The scaffold intentionally has **no success path**
and does not implement a speculative event join.

## Reproduce

From a clean checkout on the CI platform:

```sh
npm ci
npm run typecheck
npm test
```

`npm test` runs the complete suite, including the actual public host process,
project-extension discovery, `joinSession` registration and native tool
dispatch. A loopback-only scripted provider supplies invented tool calls; there
is no real model, account, authentication token or paid inference.

The host gets a temporary home, configuration directory and two synthetic Git
repositories, without inherited credentials or user configuration. Only aggregate
counts, synthetic scenario labels, status codes, public versions and elapsed
times are published in `test-results/public-host.json`. Raw prompts, events,
session identifiers and host logs are not uploaded. Temporary host state is
removed after the probe.

**The original shared-extension test only proves safe rejection.** Its report separates
`syntheticHarness` from `identityGate`; neither missing tools nor an incomplete
probe is silently classified as successful coverage.

## Historical shared-extension result

On September 10, 2026, the complete suite passed in a clean GitHub Codespace:

| Result | Measurement |
|---|---:|
| Tests | 10 passed, 0 failed |
| Direct native dispatch scenarios | 13 |
| Model-generated extension calls | 3: foreground, helper alpha, helper beta |
| Named helpers observed | 2 |
| Published dispatch latency | 5-12 ms |
| Provider requests / failures | 6 / 0 |
| Namespace selections | 0 |
| Identity decision | **NO-GO** |

The result proves the pinned public CLI can load and dispatch the scaffold and
that all covered calls fail closed within the deadline. It does not establish a
trusted definition/origin binding. The JSON artifact remains the machine-readable
source for each CI run.

During concurrent foreground switching, the public host can reject a call because
the selected tool catalog is temporarily unavailable. The shared-extension probe
records that exact failure as `HOST_TOOL_UNAVAILABLE_DURING_SWITCH`, rather than
parsing it as an adapter response. Other failures and deadline violations still
fail the suite. No such rejection counts as successful identity resolution.

## Coverage and limits

| Layer | Evidence |
|---|---|
| Adapter tests | Missing/malformed/cancelled/stale inputs; delayed metadata; duplicate names and origins; concurrent calls; reload/resume; no model-supplied owners |
| Public host | Extension loading; native dispatch; selected-agent changes; concurrent calls; real foreground/delegated model-tool dispatch with scripted responses; reload/cold resume; repository changes |
| Deadline | Synchronous adapter rejection; individual observed host dispatches must finish in less than 1,000 ms |
| Not proven | Any successful namespace binding, persistent identity, memory isolation, storage or real-model behavior |

This table describes the original shared-extension adapter. The separate
configuration-bound experiment below proves a narrower, positive tool-routing
property; it does not enable that adapter's success path.

Foreground and helper IDs observed by the test harness are **not** passed into
the adapter as authorization. No model output, query argument, environment
session ID, display name or parent selection can grant access.

## Runtime and module boundaries

| Module | Responsibility |
|---|---|
| `.github/extensions/pinocchio/extension.mjs` | Minimal host-discovered entry; requires the source build |
| `src/extension.ts` | Register one normal diagnostic tool through the host SDK |
| `src/tool.ts` | No-argument schema; reject owner/scope injection; render visible failure status |
| `src/identity.ts` | Host-independent failure contract and proposed deadline |
| `src/copilot-identity.ts` | Host-specific, fail-closed adapter; no guessed namespace or I/O |
| `src/binding-registry.ts` | Canonical identities/scopes, immutable private records and durable revocation |
| `src/bound-identity.ts` | Bounded pre/post-work validation and stale-result rejection |
| `src/bound-mcp.ts` | Production no-owner identity diagnostic over the public MCP SDK |
| `src/bindings-cli.ts` | Local bind/status/revoke commands and trusted MCP launch configuration |
| `test/support/` | Isolated public runtime and invented provider fixtures, never runtime dependencies |

The host supplies the Copilot SDK when loading the shared extension. The pinned
npm Copilot SDK is a development dependency for reproducible public-host probes.
The separate production server uses the pinned MCP SDK and Zod runtime dependencies.
There is no bundler, database, embedding engine, installer or profile mutation.
Future persistence belongs behind a separately proven identity boundary, outside
the dispatch path and the source checkout; it is not implemented here.

The extension registers no prompt hooks, submits no prompts, starts no agents,
switches no models and forces no continuation. Only the synthetic test harness
drives host lifecycle and delegation scenarios.

## Configuration-bound MCP workaround

**Measured result: 33/33 isolation cases PASS** on September 10, 2026, using
public CLI 1.0.83 / SDK 1.0.13 and Node 22.18.0 on Linux x64.
[CI evidence](https://github.com/chiedo/pinocchio/actions/runs/34531710033).
Reproduce with the same `npm ci && npm test` command; the full suite now has
11 tests and publishes `test-results/bound-mcp.json` alongside the original report.

Instead of asking a shared tool which agent called it, give each configured
agent its own stdio MCP server. The server receives immutable synthetic
definition/repository IDs at launch. Its no-argument tool cannot retarget itself.
Per-agent `mcpServers` and explicit tool allowlists are both part of this tested
configuration. Unrestricted tool inheritance is not certified.

| Public-host check | Result |
|---|---|
| Foreground and two definitions with identical display names | Each reaches its own binding |
| Direct attempts to invoke another agent's tool | No request reaches the other server |
| Model deliberately emits an unoffered cross-agent tool call | No request reaches the other server |
| Delegated helpers, including concurrent helpers | Each reaches its own binding; cross-agent attempts denied |
| Model-supplied owner argument | Rejected without an accepted server invocation |
| Foreground switches while a server call is in flight | Original binding returned; no dispatch to newly selected agent's server |
| Definition reload, warm resume and cold process restart | Explicit bindings remain correctly routed; cross-agent calls denied |
| Same definition launched for a second repository | Second binding used; first repository's server not reused |

These are execution checks, not just checks of the tools advertised to a model.
Each fixture server records accepted calls to a private synthetic journal.
Assertions compare before/after counts and the in-flight result. Only aggregate
counts are published; the journal is deleted with the temporary workspace.
An isolation regression fails CI. The scripted provider intentionally emits
unoffered tools during negative cases; ordinary provider behavior is unchanged.

The fixture in `test/support/bound-mcp-server.ts` is a minimal protocol peer,
**not** a production memory server or enrollment tool. Its IDs are invented
launch constants, not an implementation of canonical definition discovery.
Tool isolation remains distinct from OS isolation: agents with shell/file access
could access same-user files, as already described in the privacy policy.

### Production follow-through

The production registry and adapter described above now implement this
configuration-bound approach. The prototype's synthetic constant IDs are not used
by the production server. Registry metadata contains canonical local origins and
scope references; model tools accept no owner arguments.

This path requires explicit configuration/enrollment and may use one process
per agent binding rather than one shared extension process. It does not require
changing models, adding a hidden agent, or waiting for a new public SDK API.

## Gate boundary

This PASS applies to explicit per-definition MCP configuration with tool
allowlists on the tested host. It does not certify unrestricted tool inheritance,
shared session-level installation of every agent's servers, remote definitions,
desktop compatibility or OS isolation. Re-run the full gate when changing the
public host, launch configuration or binding format. Future memory writes must
still implement their own transactional scope checks and outcome-unknown
semantics; the identity adapter does not roll back side effects.
