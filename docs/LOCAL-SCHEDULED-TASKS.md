# Local scheduled and manual tasks (active owning session)

Pinocchio runs local schedules through the public native background-task API.
Each run is a separate invocation of the exact enrolled agent and is hosted by
a matching live root session. Pinocchio does not install cron or launchd, start
a detached worker, or fall back to a headless CLI process.

## Runtime contract

A local definition records:

- the trusted enrolled owner and scope;
- the approved absolute working directory;
- the prompt and either manual-only execution or a five-field cron expression
  with an IANA timezone;
- the required initialized tools and runtime limits; and
- a fingerprint of the exact approved definition.

Definitions and run history are durable in Pinocchio's SQLite jobs store.
Missed occurrences are skipped while no eligible session is live. Multiple
matching windows atomically claim one occurrence, and run-now cannot overlap an
active scheduled run.

Changing the selected agent or closing the hosting session requests targeted
cancellation. Pinocchio distinguishes a confirmed interruption from a task
whose final outcome could not be recovered. A successful run must return
non-empty output.

## Preview and publish

An enrolled agent uses the unified `pinocchio_jobs` tool with
`backend: "local"`. Preview returns the exact capability envelope, next
occurrence, draft ID, and approval token. Publishing requires a separate,
explicitly confirmed call.

CLI users can perform the same flow:

```bash
npm run jobs -- preview \
  --backend local \
  --agent example-agent \
  --id feedback-summary \
  --prompt-file ./prompt.md \
  --cron "0 10 * * 1-5" \
  --timezone America/New_York \
  --working-directory /absolute/path/to/repository \
  --tool pinocchio_memory_search \
  --tool slack-slack_search_public

npm run jobs -- publish \
  --backend local \
  --agent example-agent \
  --draft <draft-id> \
  --approval-token <approval-token> \
  --confirm
```

The selected root session must be in the approved working directory and have
all required tools initialized before a scheduled or manual run can start.
Background job agents cannot create, change, or recursively run other jobs.
Agent-owned local artifacts such as scripts, static files, caches, and job
support files belong under `~/.pinocchio/<agent-id>/`. Files intended as
repository deliverables remain in the repository.

## Repository-backed definitions

A local job can subscribe to a definition stored in a GitHub repository instead
of copying its prompt and schedule into the local database:

```bash
npm run jobs -- preview \
  --backend local \
  --agent example-agent \
  --definition "github://github/example-jobs/.pinocchio/jobs/feedback-summary.yml?ref=main" \
  --working-directory /absolute/path/to/local/workspace
```

The locator format is
`github://OWNER/REPOSITORY/PATH?ref=BRANCH_TAG_OR_COMMIT`.
Pinocchio clones the repository into the owning agent's managed directory under
`~/.pinocchio/<agent-id>/jobs/sources/`, fetches the selected ref, and resolves
the definition from an exact detached commit. Private repositories use the
machine's existing Git credentials.

Scheduled definitions use this format:

```yaml
version: 1
id: feedback-summary

schedule:
  cron: "0 10 * * 1-5"
  timezone: America/New_York

execution:
  working-directory: subscriber
  required-tools:
    - slack-slack_search_public
  timeout-minutes: 30

prompt-file: ./prompts/feedback-summary.md
```

For a manual-only repository-backed job, omit `schedule`:

```yaml
version: 1
id: interactive-feedback

execution:
  working-directory: subscriber
  required-tools:
    - computer-use-get_window_state
  timeout-minutes: 30

prompt-file: ./prompts/interactive-feedback.md
```

The tool flow is the same as the CLI flow:

```json
{
  "action": "preview",
  "backend": "local",
  "definition": "github://github/example-jobs/.pinocchio/jobs/interactive-feedback.yml?ref=main",
  "workingDirectory": "/absolute/path/to/local/workspace"
}
```

After reviewing the resolved commit, fingerprint, capabilities, and manual-only
mode, publish with the returned `draftId` and `approvalToken`, then explicitly
run it with `action: "run"`, `backend: "local"`, its `id`, and
`confirmed: true`.

Exactly one of `prompt` or `prompt-file` is required. A prompt file is resolved
relative to the definition. `working-directory: subscriber` uses the local
directory approved during preview; `working-directory: source` runs against the
managed checkout and does not require `--working-directory`. Source mode
requires a globally scoped agent because repository-scoped agents remain bound
to their approved local checkout.

The initial publication approves the repository, ref, path, working-directory
mode, required tools, runtime limits, and whether automatic execution is
allowed. Later commits may automatically change the prompt or reduce
capabilities. Scheduled jobs may become manual-only without reapproval, but a
manual-only job cannot add a schedule without a new preview and explicit
publication approval. A change that adds tools, enables automatic execution,
changes the working-directory mode, removes an approved AI-credit limit, or
increases a runtime limit is blocked with `JOB_SOURCE_REAPPROVAL_REQUIRED`.

Sources synchronize when the owning session starts, at least every five minutes
while active, immediately before a due run, before every manual run, or
explicitly:

```bash
npm run jobs -- change \
  --backend local \
  --agent example-agent \
  --id feedback-summary \
  --operation sync \
  --confirm
```

Runs fail closed when the source cannot synchronize or validate. Each run
records the exact source commit and definition fingerprint, so installations can
confirm that they executed the same revision. The run receives the managed
checkout path for repository support files and is instructed to treat it as
read-only. Pinocchio materializes immutable Git worktrees by commit so a source
refresh cannot change files underneath an active run.

Manual-only jobs appear with `schedule: null` and `nextDueAt` omitted when
listed or inspected. They never become due automatically. Run them explicitly
with the same `npm run jobs -- run ... --confirm` or `pinocchio_jobs`
`action: "run"` flow shown below.

## Inspect and manage

All administrative commands name the enrolled agent because local definitions
and history are owner-scoped:

```bash
npm run jobs -- list --backend local --agent example-agent
npm run jobs -- inspect --backend local --agent example-agent --id feedback-summary
npm run jobs -- history --backend local --agent example-agent --id feedback-summary
npm run jobs -- latest --backend local --agent example-agent --id feedback-summary

npm run jobs -- run \
  --backend local \
  --agent example-agent \
  --id feedback-summary \
  --confirm

npm run jobs -- change \
  --backend local \
  --agent example-agent \
  --id feedback-summary \
  --operation pause \
  --confirm

npm run jobs -- cancel \
  --backend local \
  --agent example-agent \
  --id feedback-summary \
  --run-id <run-id> \
  --confirm
```

Supported changes are `pause`, `resume`, and `delete`. Deletion tombstones the
definition so existing run history remains inspectable.

## Scheduling behavior

Local jobs accept five-field cron expressions and IANA timezones such as
`America/New_York`. Scheduling is evaluated minute by minute with timezone and
daylight-saving transitions applied by the runtime. Cloud GitHub Actions jobs
remain UTC-only.

The last successful output is supplied to the next run as bounded, explicitly
untrusted checkpoint data. It is context for continuity, not an instruction
source and not a substitute for durable job history.
