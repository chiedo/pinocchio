# Release evaluations

`evaluations/v1.json` freezes the initial public CLI 1.0.83 / SDK 1.0.13 /
Node 22.18.0 / Linux x64 configuration, GPT-5.4 with medium effort, deterministic
synthetic corpus, sample counts and thresholds. The report hashes the configuration,
generated corpus and prompts. The ambiguous follow-up case was added before the
first live inference; no thresholds were changed to fit observations.

## Gates

| Gate | Required evidence |
|---|---|
| Reliability | Worker faults, missing identity, duplicate writes, lost acknowledgement, correction/deletion races, real SIGKILL during index publication, locks, persisted budgets |
| Conversation lifecycle | 128 requests across four recipients, seven restart/compaction cycles, failed searches and delayed callbacks; native host compaction preserves accounting |
| Backend latency | 128 notes, 100 warm hybrid worker calls, nearest-rank p95 strictly below 250 ms; model inference excluded |
| Live foreground and helper, separately | Four recall/control pairs, four saves, one unsupported question and one contextual follow-up per role |
| Live acceptance | Search compliance, scoped retrieval and save quality at least 75%; absolute recall improvement over no-memory at least 50 percentage points; no scope leaks; both unsupported/follow-up cases correct |

The helper follow-up places prior context and the ambiguous question in one
delegated prompt; the foreground follow-up uses two actual user messages in one
session. The 128-request stress sequence uses the real worker and persisted ledger,
not 128 paid turns. Actual host compaction is exercised separately with the
loopback synthetic provider.

## Synthetic CI

Normal CI runs the **entire** suite with the scripted provider and pinned local
embedding model. It never invokes `evaluate:live`, supplies account credentials,
or makes paid inference calls. Install the pinned Python dependencies and set
`PINOCCHIO_TEST_PYTHON` as documented in [SEMANTIC.md](SEMANTIC.md).

`test-results/reliability.json` records backend p50/p95, counts and fault outcomes.
`test-results/memory-workflow.json` records native lifecycle results. An empty,
incomplete or failing sample never becomes a passing release.

## Explicitly authorized live run

Run only in an isolated Linux environment, using a credential already authorized
for Copilot. Supply it through `COPILOT_GITHUB_TOKEN` or stdin, never argv, a
committed file or a public log. These commands read the token from stdin:

```sh
npm run build
node dist/test/support/live-evaluation.js --probe --token-stdin \
  --report test-results/live-probe.json
PINOCCHIO_TEST_PYTHON="$PWD/.venv/bin/python" \
  node dist/test/support/live-evaluation.js --authorize --token-stdin \
  --report test-results/live-evaluation.json
```

The probe checks authentication, pinned host, model and effort availability
without inference. The live runner uses synthetic profiles, notes, homes and
repositories, actual enrolled MCP servers, and native foreground/helper turns.
No-memory controls cannot access MCP memory tools. Retrieval credit requires the
expected seeded record ID and marker, not an answer that happens to mention it.
Save quality requires exactly one new supported note without changing prior notes.
For diagnosis, add `--diagnose-save` to run one save prompt per role. Its aggregate
validation codes and outcome counts contain no arguments or answers, and its
`diagnostic` status can never qualify as release evidence. Invalid action values
in the initial live run motivated explicit root-level save parameters and action
instructions; strict per-action validation and acceptance thresholds remain unchanged.

Caps: 192 model calls, eight calls per trial, 4,000,000 input tokens, 200,000
output tokens, 4,000,000,000,000 nano-AI units, 90 seconds per trial and 20 minutes
per run. Nano-AI units are telemetry units, **not dollars**. Admission checks and
live telemetry trigger aborts; these are not a provider-side hard billing quota,
and in-flight usage may overshoot. Missing usage stops the run; exceeding any
measured cap fails the gate.

Reports include attempted/completed/omitted trials, failures, actual retrieval
modes, and separate foreground/helper trial/model/tool p50/p95. Cold semantic
fallbacks are reported honestly; the separate warm-backend gate requires hybrid.
Small deterministic samples establish only this initial configuration, not broad
model quality or a production latency guarantee.

## Release decision

Collect the full successful synthetic CI artifacts and authorized live report
from the **same source commit and contract hash**, then run:

```sh
npm run evaluate:release -- \
  --reliability test-results/reliability.json \
  --workflow test-results/memory-workflow.json \
  --live test-results/live-evaluation.json
```

The evaluator recomputes the acceptance decision instead of trusting `pass`
labels. Exit 0 means pass; exit 2 means failed/unvalidated evidence; exit 1 means
unreadable or invalid input. Omitted live files explicitly produce `unvalidated`.
For CI evidence, use a push run for the evaluated commit rather than a pull
request's synthetic merge commit.

Publish only aggregate JSON or a compact PR table. Never upload notes, vectors,
raw transcripts, credentials or synthetic workspace/session directories.
The runner removes its temporary workspace after collection. Keep the tracking
issue blocked until both synthetic and live evidence actually pass.
