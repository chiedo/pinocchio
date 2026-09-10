# Identity compatibility gate

**Production identity gate: NO-GO. Agent-bound MCP experiment: PASS.**
The shared extension still cannot infer a trusted caller definition.
Configuration-bound MCP servers passed the isolation experiment below, providing
an alternative that does not require a new caller-metadata API. Production
definition enrollment and lifecycle validation remain required before closing
issue #2 or starting transactional memory.

## Public baseline

| Item | Baseline |
|---|---|
| Public CLI | [1.0.83](https://github.com/github/copilot-cli/releases/tag/v1.0.83), released September 4, 2026 |
| Public SDK | [1.0.13](https://www.npmjs.com/package/@github/copilot-sdk/v/1.0.13); its package manifest pins CLI 1.0.83 |
| Runtime | Node.js 22.18.0, TypeScript, compiled ESM |
| Public-host execution | Synthetic harness PASS on `linux-x64`; identity gate NO-GO |
| Supported hosts | None; desktop and other operating systems are not certified |

The compatibility probe requires the exact public runtime and SDK versions. It
launches the locked `@github/copilot` executable, not an ambient `copilot`,
private distribution or live user session. The SDK-only standalone runtime does
not provide the full CLI's extension launcher. The probe explicitly supplies
the unmodified, pinned public npm SDK's `dist/` directory as `extensionSdkPath`.
It checks both public versions rather than using the SDK from a local CLI
installation.

## Blocker

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

**A passing test suite means the diagnostic fails closed as expected. It does
not mean the identity gate passed.** The generated report separates
`syntheticHarness` from `identityGate`; neither missing tools nor an incomplete
probe is silently classified as successful coverage.

## Measured public-host result

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
| `test/support/` | Isolated public runtime and invented provider fixtures, never runtime dependencies |

The host supplies the SDK when loading the extension. The pinned npm SDK is a
development dependency for typechecking and reproducible public-host probes.
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

### What remains before closing #2

Implement a trusted local binding registry keyed by canonical definition origin
and stable ID, not display name. Validate configuration roots, duplicate origins,
repository/global scope, invalid and missing bindings, and stale-result
invalidation. Wire it to the tested MCP configuration without accepting owner
arguments from the model. Prove those production bindings across the same host
cases before allowing memory I/O.

This path requires explicit configuration/enrollment and may use one process
per agent binding rather than one shared extension process. It does not require
changing models, adding a hidden agent, or waiting for a new public SDK API.

## Reopening the gate

Either a host caller-metadata contract or trusted configuration-bound tools must
bind each call to its definition ID and origin, repository/global scope and a
verifiable live generation. Re-run
foreground plus two helpers, duplicate names/origins, concurrent switching,
reload/resume and the one-second failure cases on a pinned public release before
adding a success path or unblocking step 2.
