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

**Already-running sessions do not automatically reload profile changes.** Start
a fresh session with the same named agent after setup. To update an ongoing
conversation immediately, send this to each live agent, substituting the exact
paths printed by setup:

```text
Read your agent profile at <profile> and the shared Pinocchio instructions at
<sharedInstructions> now. Follow the shared rules for this conversation alongside
your individual role and repository instructions. Default instruction edits to
your own profile; edit the shared file only when I explicitly ask for an
all-Pinocchio-agent change. Tell me if either file cannot be read.
```

New delegated instances receive their refreshed named profile; existing helpers
need the same message or must be relaunched. There is no broadcast to other live
sessions. After later shared-file edits, ask existing sessions to reread it;
fresh sessions are already instructed to read its current contents.

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
