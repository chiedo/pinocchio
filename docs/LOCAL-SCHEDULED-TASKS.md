# Local scheduled tasks (active owning session)

The unified `pinocchio_jobs` contract reserves local schedules for genuine
native background-agent execution while the owning agent has a live root
session. The current pinned public SDK does not expose the required start API,
so local execution is blocked rather than emulated.

## Compatibility gate

The supported public `@github/copilot-sdk` 1.0.13 declarations expose
client-side task cancellation and background-task events, but not a public
`session.rpc.tasks.startAgent(...)` method. Until a supported runtime proves
foreground responsiveness, immutable agent identity, scoped memory/MCP access,
targeted cancellation, and teardown, Pinocchio reports
`LOCAL_BACKGROUND_TASK_API_UNAVAILABLE`.

## The core problem

`copilot -s -p "<prompt>"` run non-interactively (no TTY, as launchd/cron do)
does **not** get the same tool permissions as an interactive session, even
with `--enable-memory`. MCP tools (Slack, GitHub, Pinocchio memory, etc.) are
silently unavailable unless explicitly granted. Left unhandled, the agent
degrades quietly, keeps working with whatever tools it *does* have, and can
still exit `0` — a "success" that did nothing useful.

## Rules

1. **Do not install an OS scheduler for Pinocchio local jobs.** A schedule is
   durable data, not a cron or launchd registration. Missed triggers are
   skipped when no owning session is live.

2. **Never use `--allow-all` for a legacy headless job.** It works, but it's
   blanket trust for an unattended process. Use scoped `--allow-tool` flags
   for exactly the tools the task needs, and `--available-tools` to keep the
   model's tool list minimal:

   ```bash
   copilot --agent my-agent -s -p "$PROMPT" \
     --allow-tool='slack-slack_search_public' \
     --allow-tool='slack-slack_read_channel' \
     --available-tools='slack-slack_search_public,slack-slack_read_channel'
   ```

3. **Don't rely on the Pinocchio memory extension in headless/no-TTY runs.**
   As of CLI 1.0.84-8, `--experimental --enable-memory` combined with scoped
   `--allow-tool` for `pinocchio_memory_*` can hang indefinitely in
   non-interactive mode (confirmed via repeated reproduction — the extension
   process logs `resolver hook loaded` and never spawns its MCP server).
   Until that's fixed upstream, persist checkpoint/state to a plain local
   file from your wrapper script instead of asking the agent to call memory
   tools mid-run.

4. **Do not wrap Pinocchio local jobs in a detached CLI script.** The worker
   must be a native background invocation owned by the live session.

5. **For unrelated legacy CLI calls, wrap the command in a small script, not a raw command in the plist.**
   The wrapper should:
   - take an overlap lock (e.g. `mkdir` as a lock — atomic, no extra deps) so
     retries/awake-from-sleep don't double-run;
   - read the last checkpoint from a file, defaulting sensibly if absent;
   - have the agent emit a single well-defined last line (e.g.
     `CHECKPOINT: <ISO8601>`) that the script parses;
   - **only persist the new checkpoint if the CLI exit code is 0 AND the
     checkpoint line is present and well-formed** — never persist on a
     failed or ambiguous run;
   - log a `START`/`SUCCESS`/`FAILED` line with a run ID, plus a full
     per-run log file, so failures are visible without re-running.

6. **Verify success, don't trust exit code alone at first.** `last exit code`
   from `launchctl print` can be `0` even when the agent quietly couldn't use
   a tool it needed. Test by inspecting real output, not just the exit code,
   the first few times a new scheduled job runs.

7. **Test through the real scheduler**, not just by running the command in a
   terminal — `launchctl kickstart -k gui/<uid>/<label>` triggers an
   immediate real run. Confirm two consecutive runs: the first persists a
   checkpoint, the second resumes from it without gaps or duplicates.

## Example

See `~/.copilot/agents/state/competitor-feedback-check.sh` (local machine,
not in this repo) for a working reference implementation of the above.
