# Identity compatibility gate

**Gate: NO-GO.** No caller-to-definition binding has been proven. Do not close
issue #2, start transactional memory (step 2), or enroll profiles on the strength
of a green synthetic test run.

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

## Reopening the gate

**Upstream dependency:** [github/copilot-sdk#2611](https://github.com/github/copilot-sdk/issues/2611).
The request asks for either a supported existing correlation contract or
host-provided call-scoped metadata. Adding optional fields only to the SDK types
would not solve this: the executing host must populate and validate them.

Review of the pinned public SDK's dispatch implementation confirms that it passes
session/tool-call IDs, arguments, tracing and cancellation to the handler, not a
definition binding. The event alternative is also incomplete:

| Public surface | Missing authority |
|---|---|
| `tool.execution_start` | Optional helper instance ID, but no resolved definition/origin snapshot |
| `subagent.started` / `subagent.selected` | Names/types, not a complete call-time definition binding |
| `tasks.list` | Execution/type information, not the definition snapshot used at invocation |
| `agent.list` / `agent.getCurrent` | Current definitions/selection, not an in-flight call's historical binding |

These observations establish a contract gap, not a proof that every possible
host integration is impossible. Maintainer confirmation of a supported event
join could also unblock implementation; a guessed ordering cannot.

A future public-host contract must bind each call to its executing definition
ID and origin, repository/global scope and a verifiable live generation. Re-run
foreground plus two helpers, duplicate names/origins, concurrent switching,
reload/resume and the one-second failure cases on a pinned public release before
adding a success path or unblocking step 2.

Landing order: resolve the upstream contract; implement the Pinocchio adapter
against it; demonstrate successful namespace bindings in the public-host suite;
merge that change and close #2; then implement storage under #3. Merging the
fail-closed scaffold alone does not satisfy the gate.
