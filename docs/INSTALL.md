# Add Pinocchio to your existing Copilot CLI

**Use your normal `copilot`. No second CLI, separate login, or launcher.**
Pinocchio installs a memory extension and a named agent with its own memory tools.
The extension provides the tools directly; agent profiles do not launch their
own MCP processes. It is not a skill-only installation.

**Conversation memory is on by default for enrolled, selected agents.** New
user messages and assistant responses are captured locally as they arrive;
relevant earlier-session passages are supplied before your next prompt.
You do not have to say "remember this." Existing enrolled agents get this
behavior after restarting the CLI with the rebuilt extension.

## Install

Requires an existing `copilot` on PATH, Node.js 22.18 or newer **22.x**, and npm.
Linux and macOS are preview targets; live-model certification remains unvalidated.

Clone this repository into a location you will keep, then run:

```bash
npm ci
npm run setup -- --repository /absolute/path/to/your/project
```

This creates the `pinocchio` agent in your existing Copilot configuration
(normally `~/.copilot`), scoped to that Git repository. It does not replace
unrelated agent files or change your login, model, native memory, or permissions.
For another name, append `--name builder`. For intentionally cross-repository
memory, use `--global` instead of `--repository`.

The generated profile tells the agent its filename-based ID, exact profile path,
configuration root, and memory scope. It also explains the YAML settings, authored
instructions, separate memory storage, and which generated wiring to preserve.
This context is part of the profile, so it also applies when the agent is delegated
helper work; no memory search is needed to discover its own configuration.

**Keep this checkout and its `node_modules`: they supply the runtime.** Setup
does not copy or launch a second CLI. The current dependency lock still includes
a pinned CLI used by developer validation; your normal CLI remains the host.

## Try it

Restart Copilot, then select `/agent pinocchio`, or start it directly:

```bash
cd /absolute/path/to/your/project
copilot --agent pinocchio
```

Say: "Remember this synthetic project fact: the demo release is Copper Finch.
Source: this manual entry. Confirm whether the save committed."

Start a fresh session with the same agent and ask:
"Search your memory for the demo release name and cite its source."

Only enrolled named agents get this memory. Each has a separate store; an
unnamed session does not automatically gain it. Repository-scoped agents must
run in the repository used during setup. Recall by the model is best-effort.

Capture applies to the selected foreground agent, not unnamed sessions or
delegated helper event streams. Helpers still have their explicit scoped
memory tools. Old session transcripts are not retroactively imported.

## Conversation controls

```bash
npm run setup -- --pause-conversation
npm run setup -- --resume-conversation
# Append --name builder for another agent.
```

These controls take effect without restarting. Pausing stops automatic capture
and recall; explicit memory tools remain available. Removal below stops both
by removing the agent's memory integration.

Captured text is chunked into SQLite notes with speaker, time, and source IDs.
Assistant text is marked tentative, never treated as a user-confirmed fact.
Keyword/recency recall works immediately; optional FAISS retrieval is used when
configured. Raw tool output, hidden reasoning, attachments, and system-injected
messages are excluded. Recognizable credentials and identifiers are redacted,
but pattern matching cannot guarantee that all sensitive text is detected.
Pause before discussing anything you do not want retained.

Conversation retention is 30 days with a target cap of 2,500 chunks per agent
scope. Cleanup removes up to 100 expired/excess chunks per captured message;
it runs during capture, not while the CLI is closed. Curated notes are not
removed by this cleanup. Use the existing scoped `memory forget` command to
delete individual captured notes. Deletion cannot retract prior model context.
Automatic recall shares the existing per-request and per-session context budgets.

## Update or remove

Exit sessions using Pinocchio before rebuilding. From this checkout:

```bash
git pull --ff-only
npm ci
npm run setup -- --repository /absolute/path/to/your/project
```

Repeat the original name and scope. Re-running setup checks the existing
binding and refreshes older generated guidance rather than creating a second
agent. Your authored instructions, YAML settings, binding, and stored notes are
preserved. Repeat setup for each existing agent, then start fresh sessions to
load the updated profiles.

### Shared instructions and live sessions

Setup creates `<config-root>/pinocchio/AGENTS.md`, normally
`~/.copilot/pinocchio/AGENTS.md`, once and preserves its contents on later setups.
Every enrolled agent profile names that exact file and instructs the agent to
read it at session start, including delegated helper work. This is profile-driven
guidance, not host-enforced injection or a new memory scope. An agent without file
read permission must report the blocker rather than claim it loaded the rules.

The shared rules supplement individual roles and repository instructions; they do
not override higher-priority instructions. **Instruction edits default to the
individual agent profile.** Only explicitly all-Pinocchio-agent changes belong
in the shared file; "always" or "remember" alone does not establish that scope.
Removing an agent's memory integration leaves the shared file for other agents.

After installing this update, repeat each agent's original setup command (same
name, configuration root, and global/repository scope). This upgrades both older
memory-only profiles and the previous self-awareness profiles without changing
authored text or memory bindings. For profiles enrolled through the lower-level
CLI, use `npm run enroll -- refresh` with the original binding and fingerprint
(and `--allow-shared` for repository/plugin profiles).

Sessions that predate the broadcast listener need one restart. After that
bootstrap, `npm run broadcast -- upgrade` reloads profile instructions, agent
definitions, managed tool allowlists, and changed extension runtime code in live
listening sessions. To update a session without the listener, send this message,
substituting the exact paths printed by setup:

```text
Read your agent profile at <profile> and the shared Pinocchio instructions at
<sharedInstructions> now. Follow the shared rules for this conversation alongside
your individual role and repository instructions. Default instruction edits to
your own profile; edit the shared file only when I explicitly ask for an
all-Pinocchio-agent change. Tell me if either file cannot be read.
```

New delegated instances receive their refreshed named profile; existing helpers
need the same message or must be relaunched. For foreground sessions with the
broadcast listener installed, use the command below instead of messaging each one.
Fresh sessions are already instructed to read the shared file's current contents.

### Broadcast an instruction upgrade

From the checkout that supplies your installed extension:

```bash
npm run build
npm run broadcast -- upgrade
npm run broadcast -- status
# Add --config-root /path/to/copilot/config to target another configuration.
```

`upgrade` refreshes all enrolled user profiles using their existing bindings and
scopes, then publishes a local update notice. It preserves authored instructions,
settings, and memory; it does not pull code, install dependencies, grant permissions,
or publish/sync cloud jobs. Repository/plugin profiles that require explicit
shared-enrollment approval are reported as failures rather than changed implicitly.
Run their documented enrollment refresh separately.

Each listening foreground conversation checks every five seconds and updates the
selected agent's authored prompt through the host API. **Refreshes are silent:**
no synthetic user message, acknowledgment, or extra model request, including on
startup and extension reload. Ongoing work is not interrupted; subsequent work uses
the refreshed instructions. Repeating an unchanged broadcast does not stack
instructions. Updates are not copied into conversation memory.
If an agent profile or the shared instructions change after a broadcast is
published, listeners read and deliver the newest files. A further change during
delivery leaves the session pending and retries silently on the next heartbeat.

Only the selected agent's body and shared instructions are updated; its identity,
YAML settings, tools, and permissions are preserved. The profile text goes to the
session's configured model as part of normal instructions, not a separate refresh
turn. It is not stored in the broadcast registry.

`status` reports each live listener as `pending`, `updated`, `restart-required`, or
`failed`. `updated` means the host accepted the matching authored prompt, with the
selected agent, instruction snapshot, runtime, and Pinocchio's managed tools
checked. It is not proof of model compliance or removal of old instructions from
conversation history. Repository rules and higher-priority instructions still win.
Restart for a clean conversation without earlier instruction snapshots.

A failed refresh or required restart produces one actionable timeline warning per
failure, not an agent response. Hosts without the prompt-update API fail explicitly;
Pinocchio never falls back to sending a chat turn. Inspect `status` for details and
rerun `upgrade` after resolving the problem.

Runtime changes trigger one guarded extension reload in each live session.
Changed YAML settings and stale managed-tool allowlists trigger an agent
definition reload. If the runtime still does not match after reloading, status
reports `restart-required` with `RUNTIME_RELOAD_FAILED` rather than looping.
Missing managed memory/job tools report `failed` with
`code: TOOLS_NOT_AVAILABLE` and the exact `missingTools`. The listener rechecks
these automatically every five seconds, so tools finishing initialization
can recover without another broadcast or restart. Startup tool warnings allow two
polling intervals for registration to finish. If tools remain missing,
inspect the Pinocchio extension's load status rather than repeatedly restarting.

An agent's `tools` list is an allowlist, not a list of required dependencies.
Unmatched non-Pinocchio entries (including platform-specific names and aliases
the metadata does not advertise) are reported as `unmatchedTools`, but do not
block an instruction refresh. This neither enables those tools nor changes
the profile or its permissions.

The listener invokes the host's extension reload API at most once for each
session and broadcast runtime. The replacement listener completes the same
broadcast after it starts. Inspect the per-agent errors for partial failures;
`status` exits nonzero for failures or required restarts, not merely pending work.
Rerun `upgrade` after resolving failures. A newer broadcast supersedes the prior target.

**First installation needs a one-time restart of existing sessions.** Older
processes have no listener and cannot be discovered or upgraded by this command.
After that bootstrap, future runtime, managed-tool, and instruction upgrades do
not require manually restarting each open process.
Coverage is limited to listening foreground sessions sharing this configuration
root, not other machines, existing delegated helpers, or GitHub Actions jobs.
Empty results do not mean every open conversation was upgraded. Heartbeats older
than 30 seconds are excluded, so suspended sessions reappear when they resume.
Private registry files under `pinocchio/broadcast` contain only identifiers,
version hashes, tool names, timestamps, and status. A leftover `upgrade.lock`
after a crashed publisher reports `BROADCAST_BUSY`; remove that exact file only
after confirming no broadcast command is running.

To remove memory from this agent:

```bash
npm run setup -- --remove
# For a different name: npm run setup -- --remove --name builder
```

Restart Copilot afterward. Removal preserves the agent's other instructions and
stored notes. The shared context extension remains for other enrolled agents;
keep the checkout while that extension is installed. Modified managed settings
produce an explicit conflict rather than being overwritten.

## Preview limitations

The normal CLI path uses extension-local fallback accounting: 800 bytes per call
and 6,000 bytes per extension process. Keyword search works without downloading
embeddings. See [optional semantic search](SEMANTIC.md),
[memory administration](STORAGE.md), and [privacy](../PRIVACY.md).

The [isolated developer preview](ISOLATED-PREVIEW.md) retains the pinned CLI,
synthetic diagnostic gate, runtime snapshots, and rollback workflow. These are
not prerequisites for trying Pinocchio in your existing CLI.

## Optional cloud jobs

Enrolled agents can publish explicitly approved, read-only scheduled jobs to a
private GitHub Actions repository. Memory and conversation history remain
local; the cloud receives the approved prompt and a sanitized snapshot of the
selected `~/.copilot/agents/<agent-name>.agent.md`.

See [Cloud-scheduled agent jobs](CLOUD-JOBS.md) for configuration, repository
bootstrap, authentication, previews, results, drift checks and removal.
