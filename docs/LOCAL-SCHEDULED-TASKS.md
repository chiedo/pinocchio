# Local scheduled tasks (launchd/cron)

Best practices for running a Pinocchio agent unattended on your own machine,
based on real failures found while debugging a daily launchd job.

## The core problem

`copilot -s -p "<prompt>"` run non-interactively (no TTY, as launchd/cron do)
does **not** get the same tool permissions as an interactive session, even
with `--enable-memory`. MCP tools (Slack, GitHub, Pinocchio memory, etc.) are
silently unavailable unless explicitly granted. Left unhandled, the agent
degrades quietly, keeps working with whatever tools it *does* have, and can
still exit `0` — a "success" that did nothing useful.

## Rules

1. **Never use `--allow-all` for a scheduled job.** It works, but it's
   blanket trust for an unattended process. Use scoped `--allow-tool` flags
   for exactly the tools the task needs, and `--available-tools` to keep the
   model's tool list minimal:

   ```bash
   copilot --agent my-agent -s -p "$PROMPT" \
     --allow-tool='slack-slack_search_public' \
     --allow-tool='slack-slack_read_channel' \
     --available-tools='slack-slack_search_public,slack-slack_read_channel'
   ```

2. **Don't rely on the Pinocchio memory extension in headless/no-TTY runs.**
   As of CLI 1.0.84-8, `--experimental --enable-memory` combined with scoped
   `--allow-tool` for `pinocchio_memory_*` can hang indefinitely in
   non-interactive mode (confirmed via repeated reproduction — the extension
   process logs `resolver hook loaded` and never spawns its MCP server).
   Until that's fixed upstream, persist checkpoint/state to a plain local
   file from your wrapper script instead of asking the agent to call memory
   tools mid-run.

3. **Wrap the CLI call in a small script, not a raw command in the plist.**
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

4. **Verify success, don't trust exit code alone at first.** `last exit code`
   from `launchctl print` can be `0` even when the agent quietly couldn't use
   a tool it needed. Test by inspecting real output, not just the exit code,
   the first few times a new scheduled job runs.

5. **Test through the real scheduler**, not just by running the command in a
   terminal — `launchctl kickstart -k gui/<uid>/<label>` triggers an
   immediate real run. Confirm two consecutive runs: the first persists a
   checkpoint, the second resumes from it without gaps or duplicates.

## Example

See `~/.copilot/agents/state/competitor-feedback-check.sh` (local machine,
not in this repo) for a working reference implementation of the above.
