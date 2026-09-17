# Local scheduled tasks (active owning session)

Pinocchio runs local schedules through the public native background-task API.
Each run is a separate invocation of the exact enrolled agent and is hosted by
a matching live root session. Pinocchio does not install cron or launchd, start
a detached worker, or fall back to a headless CLI process.

## Runtime contract

A local definition records:

- the trusted enrolled owner and scope;
- the approved absolute working directory;
- the prompt, five-field cron expression, and IANA timezone;
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
