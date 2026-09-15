# Cloud-scheduled agent jobs

Pinocchio can publish an approved, read-only agent job to a private GitHub
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

Create the local configuration:

```bash
npm run jobs -- configure \
  --repository some-owner/pinocchio-jobs \
  --confirm
```

This writes `~/.pinocchio/config.yml` with mode `0600`. It stores a repository
name and the name of an Actions secret, never the secret value:

```yaml
version: 1
jobs:
  provider: github-actions
  repository: some-owner/pinocchio-jobs
  token_secret: PINOCCHIO_COPILOT_TOKEN
  require_approval: true
  agent_sync:
    check_interval: 24h
    check_on_startup: true
    update_policy: require-approval
```

Create the configured repository, or verify that an existing repository is
private and writable:

```bash
npm run jobs -- bootstrap --confirm
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

After installing or updating Pinocchio, repeat the normal setup command for
each enrolled agent and restart Copilot CLI. Refreshing setup adds the cloud
job tool to the agent profile without changing authored instructions.

## Preview and publish

From an enrolled agent, ask it to schedule a job. The agent must first call
`pinocchio_cloud_jobs` with `action: preview`. The result contains:

- the exact prompt, sanitized profile, manifest and workflow to be uploaded;
- the canonical local source profile;
- warnings and blockers;
- a short-lived draft ID and approval token.

Publishing requires a separate tool call after explicit approval. CLI users
can perform the same two-phase flow:

```bash
npm run jobs -- preview \
  --agent example-agent \
  --id daily-release-notes \
  --prompt-file ./prompt.md \
  --cron "30 12 * * 1-5"

npm run jobs -- publish \
  --draft <draft-id> \
  --approval-token <approval-token> \
  --confirm
```

Schedules use five-field cron expressions in **UTC**. GitHub Actions schedules
are approximate and are not suitable for exact-time or safety-critical work.

The initial tool allowlist is deliberately read-only: `view`, `rg`, `glob` and
`web_fetch`. Requested tools must already be present in the local agent profile.
`web_fetch` additionally requires one or more reviewed HTTPS `--allow-url`
values; unrestricted URL access is not enabled.
The workflow also grants only `contents: read`, disables persisted checkout
credentials, starts Copilot in that job's directory so sibling job prompts and
profiles are outside its allowed path, prevents overlapping runs, applies a
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
- replaces the tool list with the approved read-only tools; and
- blocks publication when authored instructions still reference likely local
  home paths.

The original local file is never modified. Pattern matching cannot guarantee
that an authored profile or prompt contains no sensitive information, so the
exact preview remains the security boundary.

## Results and lifecycle

When an enrolled agent session is open, Pinocchio checks for newly completed
runs belonging to that agent after startup and every five minutes. Successful
and failed runs trigger a non-billable agent notification with their completion
time, status and Actions URL. If the session closes before delivery, the result
remains unread and is announced in the next matching session. Pinocchio cannot
notify through a closed CLI session. Checks fail open when GitHub is
unavailable, and notification/result text is never imported into memory
automatically. A short-lived cross-process claim prevents extension reloads
from announcing the same runs more than once; failed deliveries release the
claim immediately and interrupted deliveries become retryable after five
minutes.

```bash
npm run jobs -- list
npm run jobs -- latest --id daily-release-notes
npm run jobs -- latest --id daily-release-notes --include-result

npm run jobs -- change --id daily-release-notes --operation pause --confirm
npm run jobs -- change --id daily-release-notes --operation resume --confirm
npm run jobs -- change --id daily-release-notes --operation delete --confirm
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
npm run jobs -- drift
npm run jobs -- change \
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
