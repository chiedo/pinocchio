# Agent-owned jobs

Pinocchio exposes one `pinocchio_jobs` interface for local and cloud jobs.
Definitions and run history are authoritative; memory search is never used to
decide whether an agent has schedules or completed work.

Local jobs use the public native background-task API. They run as a separate
invocation of the exact enrolled agent only while a matching root session is
live. Pinocchio does not substitute cron, launchd, a detached worker, or a
headless CLI.

Cloud jobs remain independent of local session lifetime and are published to
the repository selected for that job.

## Local active-session jobs

Ask an enrolled agent to preview a local job with:

```json
{
  "action": "preview",
  "backend": "local",
  "id": "feedback-summary",
  "prompt": "Summarize new feedback from the approved source.",
  "cron": "0 10 * * 1-5",
  "timezone": "America/New_York",
  "workingDirectory": "/absolute/path/to/the/approved/repository",
  "tools": [
    "pinocchio_memory_search",
    "pinocchio_memory_save",
    "slack-slack_search_public"
  ]
}
```

The preview returns the exact owner, prompt, schedule, working directory,
required tools, limits, next occurrence, draft ID, and approval token. After
explicit approval, publish the draft. The definition remains durable, but it
only runs while that exact enrolled agent and scope has a live root session in
the approved working directory.

Triggers missed while no matching session is live are skipped. Multiple
matching windows atomically claim one occurrence. Run-now cannot overlap a
scheduled run. Changing the selected agent or closing the hosting session
requests targeted cancellation and records interruption separately from an
unknown outcome.

Pinocchio can publish an approved agent job to a private GitHub
repository. GitHub Actions runs the job even when the local computer is off.

This feature does **not** upload Pinocchio memory or conversation history. It
publishes only:

- the approved task prompt;
- a cloud-safe snapshot derived from the selected
  `~/.copilot/agents/<agent-name>.agent.md`;
- a small job manifest; and
- the GitHub Actions workflow.

The prompt, agent instructions, workflow logs and retained results are still
cloud data. Review the preview before publishing.

## Configure a jobs repository

Register a private repository for an enrolled agent:

```bash
npm run jobs -- configure \
  --agent example-agent \
  --repository some-owner/pinocchio-jobs \
  --confirm
```

This creates a private owner-scoped repository registration under
`~/.pinocchio` and makes it the enrolled agent's default for new previews.
Every cloud job persists its own resolved destination. Pinocchio stores the
repository, default branch, and the name of an Actions secret, never the secret
value. Existing legacy `~/.pinocchio/config.yml` settings remain supported.

Create the configured repository, or verify that an existing repository is
private and writable:

```bash
npm run jobs -- bootstrap \
  --agent example-agent \
  --repository some-owner/pinocchio-jobs \
  --confirm
```

Repository creation is never implicit. Pinocchio refuses to publish to a
public or read-only repository.

Add an Actions repository secret named `PINOCCHIO_COPILOT_TOKEN`. It must
contain credentials accepted by Copilot CLI for unattended GitHub Actions
usage. The workflow passes it only as `COPILOT_GITHUB_TOKEN` and asks Copilot
CLI to redact that variable. GitHub's current documentation describes both
eligible `GITHUB_TOKEN` setups and fine-grained personal access tokens with
the **Copilot Requests** permission. Set `token_secret: GITHUB_TOKEN` only when
the configured repository is eligible for GitHub's built-in token flow;
Pinocchio then grants only `contents: read` and `copilot-requests: write`, and
passes the short-lived token as `GITHUB_TOKEN`. Otherwise Pinocchio verifies
that the named repository secret exists before publishing and passes it as
`COPILOT_GITHUB_TOKEN`.

After installing or updating Pinocchio, run `npm run build` and
`npm run broadcast -- upgrade`. Sessions that predate the broadcast listener
need one initial restart; later runtime, managed-tool, and instruction updates
reload through the listener.

## Preview and publish

From an enrolled agent, ask it to schedule a cloud job. The agent must first
call `pinocchio_jobs` with `backend: cloud` and `action: preview`. A preview
may provide a repository different from the configured default. The result contains:

- the exact prompt, sanitized profile, manifest and workflow to be uploaded;
- the canonical local source profile;
- warnings and blockers;
- a short-lived draft ID and approval token.

Published destinations are registered to the trusted owner. `list`, `inspect`,
`history`, unread-result polling, and drift checks aggregate only those
registered repositories. If one repository is unavailable, other cloud
repositories and local jobs still return with a source-level partial error.

Publishing requires a separate tool call after explicit approval. CLI users
can perform the same two-phase flow:

```bash
npm run jobs -- preview \
  --agent example-agent \
  --id daily-release-notes \
  --prompt-file ./prompt.md \
  --cron "30 12 * * 1-5"

npm run jobs -- publish \
  --agent example-agent \
  --draft <draft-id> \
  --approval-token <approval-token> \
  --confirm
```

Schedules use five-field cron expressions in **UTC**. GitHub Actions schedules
are approximate and are not suitable for exact-time or safety-critical work.

New jobs default to `tools: ["*"]`: all available tools, shell commands,
runner file paths, and URLs are permitted without interactive confirmation.
They can install software and execute arbitrary code. This also means a job
can read credentials supplied to its runner; only publish trusted prompts
and review the exact upload before approval.

Permissive jobs install Playwright 1.63.0 with Chromium, Firefox, WebKit, and
their system dependencies. Agents can use the `playwright` command or Node.js
`require('playwright')` (provided through `NODE_PATH`); ESM scripts can use
`createRequire` to resolve that installation. Headless browsers need no desktop
session. Save screenshots, downloads, and other deliverables in
`PINOCCHIO_OUTPUT_DIR`; they are retained in a separate
`pinocchio-<job-id>-output` Actions artifact, while the text response remains
in the result artifact. Local browser logins and cookies are not transferred.

To retain the restricted mode, explicitly select tools from `view`, `rg`,
`glob`, and `web_fetch`, for example `--tool view --tool rg --tool glob`.
Restricted tools must already be present in the local agent profile (or its
tool list must contain `*`). `web_fetch` additionally requires one or more
reviewed HTTPS `--allow-url` values. Do not combine `*` with other tools or
URL allowlists: permissive mode allows every URL.

Existing jobs retain their approved tool lists when synced or resumed.
To upgrade one, preview and publish the same job ID with `tools: ["*"]`
(CLI: `--tool '*'`), and explicitly approve the new upload.
The workflow also grants only `contents: read`, disables persisted checkout
credentials, starts Copilot in that job's directory so sibling job prompts and
profiles are outside restricted jobs' allowed path (permissive jobs can access
the whole runner), prevents overlapping runs, applies a
timeout and an AI-credit limit of at least 30, installs Pinocchio's tested
Copilot CLI version, and retains the final response or CLI failure as an
Actions artifact. Copilot failures propagate to the workflow instead of being
masked by output capture. Republish legacy jobs configured below 30 credits;
profile sync refuses to silently raise an already approved limit.

Set `unlimitedAiCredits: true` in a tool preview, or pass
`--unlimited-ai-credits` to the CLI preview, to explicitly omit Copilot's soft
AI-credit cap. The published manifest records this as `max_ai_credits: null`;
the workflow timeout still applies.

## Cloud-safe agent snapshots

The source is always the selected enrolled profile at:

```text
~/.copilot/agents/<agent-name>.agent.md
```

Pinocchio verifies this from its trusted binding rather than accepting a
model-provided path. It then:

- removes the generated Pinocchio memory/integration block;
- removes memory and cloud-management tools;
- removes local skills and MCP server definitions;
- replaces the tool list with the approved tools (`*` by default); and
- blocks publication when authored instructions still reference likely local
  home paths.

The original local file is never modified. Pattern matching cannot guarantee
that an authored profile or prompt contains no sensitive information, so the
exact preview remains the security boundary.

## Results and lifecycle

When an enrolled agent session is open, Pinocchio checks for newly completed
runs belonging to that agent after startup and every five minutes. Successful
and failed runs trigger a non-billable agent notification with their completion
time, status, Actions URL, and the actual artifact content for the newest run
per job. Automatic content is capped at 32 KiB and treated as untrusted data,
not instructions. Successfully reported full content is marked read; metadata
and truncated or unavailable content remain distinguishable in local state. If
the session closes before delivery, the result remains unread and is announced
in the next matching session. Pinocchio cannot notify through a closed CLI
session. Checks fail open when GitHub is unavailable, and notification/result
text is never imported into memory automatically. A short-lived cross-process
claim prevents extension reloads from announcing the same runs more than once;
failed deliveries release the claim immediately and interrupted deliveries
become retryable after five minutes.

```bash
npm run jobs -- list --agent example-agent
npm run jobs -- latest --agent example-agent --id daily-release-notes
npm run jobs -- latest --agent example-agent --id daily-release-notes --include-result

npm run jobs -- change --agent example-agent --id daily-release-notes --operation pause --confirm
npm run jobs -- change --agent example-agent --id daily-release-notes --operation resume --confirm
npm run jobs -- change --agent example-agent --id daily-release-notes --operation delete --confirm
```

Retrieving a completed run with `--include-result` marks it read locally and
prevents a later automatic notice for that run.

Pausing removes the schedule but keeps manual dispatch. Deleting removes the
job definition and workflow from the jobs repository. Existing GitHub Actions
runs, logs and artifacts remain subject to GitHub's retention and deletion
controls.

## Profile drift

The local extension checks published snapshots when it starts and then at the
configured interval while it remains active. A cloud job continues using its
last approved snapshot while the computer is off.

```bash
npm run jobs -- drift --agent example-agent
npm run jobs -- change \
  --agent example-agent \
  --id daily-release-notes \
  --operation sync \
  --approval-token <token-from-drift-report> \
  --confirm
```

Drift is computed by regenerating the cloud-safe export from the recorded
`~/.copilot/agents/<agent-name>.agent.md`, then comparing it with the actual
published file. The report distinguishes local source changes, remote edits,
missing profiles and invalid exports. Sync refuses to overwrite remote edits
and requires the approval token tied to the exact reported diff.
