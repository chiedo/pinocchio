# 👃 Pinocchio

**Make Copilot CLI agents real by giving them memory.** Each named agent remembers what it
learned in past conversations — your preferences, decisions, and unfinished
work — so you stop re-explaining context every session.

<img width="2014" height="1338" alt="Pinocchio agent memory screenshot" src="https://github.com/user-attachments/assets/2c681738-274b-4acf-9144-142b2ae25c9e" />

That screenshot is the end state this README walks you to: several named
Copilot CLI agents, each with its own memory, running as tabs inside
[Herdr](https://herdr.dev/) — a terminal multiplexer built for coding agents.

## Why

Copilot CLI's built-in memory is one shared, global/repo-level store — it
doesn't distinguish between your different custom agents. Pinocchio gives
each named agent its own isolated memory it can search and update across
sessions, so an agent named `builder` and one named `reviewer` each remember
their own history instead of sharing one pool.

- **Per-agent memory** — a `builder` agent and a `reviewer` agent each get
  their own store; they never bleed into each other.
- **Global or project-scoped, per agent** — bind an individual agent's memory
  to everywhere, or to one repository.
- **Local by default** — memory lives in SQLite on your machine
  (`~/.copilot/agent-memories/`), not a hosted service.
- **Adds to, not replaces** — layers on top of Copilot CLI's own built-in
  [memory feature](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory),
  which is one global/repo-level store shared across sessions rather than
  scoped per agent.
- **Automatic capture** — no need to say "remember this"; conversations are
  captured as you go.
- **Unified agent-owned jobs** — inspect local and cloud schedules through one
  `pinocchio_jobs` tool. Local jobs run as native background agents only while
  their owning agent has a live session. Cloud jobs can each use a different
  private GitHub Actions repository and continue while the local computer is
  offline.

## Requirements

- macOS or Linux
- [Copilot CLI](https://github.com/github/copilot-cli), Git, npm
- Node.js **22.18–22.x**
- Python **3.12** for default local semantic search (or explicitly use `--keyword-only`)

## Quick start

**Want a useful agent out of the box?**
[Setting up your first agent](docs/FIRST-AGENT.md) walks through a Chief of Staff
example, connecting MCP servers, and checking that memory and tools really work.
Reuse the template for a researcher, assistant, or engineer.

### 1. Install Pinocchio

```bash
git clone https://github.com/chiedo/pinocchio.git
cd pinocchio
npm ci
```

Keep this folder where it is — it supplies the runtime every enrolled agent uses.

### 2. Create an agent

Global (usable in any repo):

```bash
npm run setup -- --name builder --global
```

Or scoped to one project:

```bash
npm run setup -- --name reviewer --repository /absolute/path/to/your/project
```

Run this again with a different `--name` for each agent you want — a
`builder`, a `reviewer`, a `researcher`, whatever your workflow needs. Setup
preserves any custom instructions already in an existing profile.

Setup now prepares **local semantic + keyword search by default**. The first
agent downloads about 24 MB of pinned model files plus Python dependencies into
a managed environment; subsequent agents share that runtime, not their memories.
Nothing is uploaded for embedding. Setup reports ready only after indexing and
a real local search succeed. Add `--keyword-only` to opt out persistently, or
`--hybrid` to re-enable later.

For existing enrolled agents, after building the reviewed update:

```bash
npm run build
node dist/src/semantic-cli.js setup --all
```

This preserves explicit opt-outs. Instruction broadcasts do not install
dependencies. See [setup and repair](docs/SEMANTIC.md#setup-and-upgrade).
Commands print readable summaries and actionable errors by default. Add
`--json` to any command when piping its output to another program.

### 3. Give it instructions

Edit the profile path printed by setup (for `builder`, normally
`~/.copilot/agents/builder.agent.md`). Replace the default text **below the
YAML frontmatter and above the generated Pinocchio memory block**:

```markdown
You are a software engineer.

- Read the existing code before making changes.
- Implement focused fixes and add relevant tests.
- Explain what changed and any remaining risks.
```

Keep the generated memory tool entries and memory block intact, and don't
move or rename the file — its path is part of its memory identity.

**You don't have to write this by hand.** Open a chat with the agent and ask
it directly: *"read your own profile and add instructions for X"* or *"build
out a profile for a code-reviewer agent that does Y."* The agent can read and
edit its own `.agent.md` file, so let it draft its own instructions and just
review the diff.

### 4. Chat

```bash
copilot --agent builder
```

Approve the Pinocchio extension if prompted, then talk normally. Close the
session, start another with the same agent, and it picks up where you left
off.

## Run your agents in Herdr

Copilot CLI is one terminal process per agent. Once you have more than one
agent, you want a place to run them side by side, see which ones are stuck,
and reattach after closing your laptop. That's [Herdr](https://herdr.dev/) —
the screenshot at the top of this README is Herdr running several Pinocchio
agents as tabs, plus a repo pane.

**Install:**

```bash
curl -fsSL https://herdr.dev/install.sh | sh
```

(also available via `brew install herdr`, `mise use -g herdr`, or a
[direct binary](https://github.com/herdrdev/herdr/releases))

**First run:** `cd` into a project and start Herdr —

```bash
herdr
```

It creates a workspace for that project automatically. Open a pane and start
a Copilot CLI agent in it (`copilot --agent builder`); Herdr detects it and
marks the pane `working`, `blocked`, or `idle` so you can tell which agent
needs you without reading every pane.

**Turn on terminal notifications.** Herdr can flag you at the OS level when
an agent goes from `working` to `blocked` or `done`, instead of you polling
tabs. Open Herdr's settings and enable notifications there — with several
agents running, this is the difference between actually multitasking and
babysitting one tab at a time.

**Recommended terminal: [Ghostty](https://ghostty.org/).** It's GPU-accelerated,
starts in well under a second, and stays smooth even with several busy agent
panes open at once. Herdr runs in any terminal, but Ghostty is the one we run
it in day to day. Install with `brew install --cask ghostty` on macOS, or see
[ghostty.org/download](https://ghostty.org/download) for Linux.

## Schedule recurring work

You don't need to learn a CLI for this — just tell your agent what you want
in plain language:

> "Every weekday morning, check my open PRs for new review comments and
> summarize them for me."

The agent uses the built-in `pinocchio_jobs` tool to turn that into a real
scheduled job (local, tied to a live session, or a cloud job that runs even
when your machine is off), and it will show you the exact schedule and ask
for approval before publishing anything. See
[Local scheduled tasks](docs/LOCAL-SCHEDULED-TASKS.md) and
[Agent-owned jobs](docs/CLOUD-JOBS.md) if you want the underlying detail.
Repository job files are also portable: a non-Pinocchio agent can follow
[the manual runner contract](docs/NON-PINOCCHIO-JOBS.md), including when an
external cron service or scheduler launches it.

## Managing memory

```bash
npm run setup -- --name builder --pause-conversation   # stop capture/recall
npm run setup -- --name builder --resume-conversation  # resume
npm run setup -- --name builder --remove               # disconnect memory tools
```

Pausing stops automatic capture. Removal disconnects memory tools after a
restart but keeps stored notes and the agent's other instructions.

## Good to know

- Recall isn't perfect: automatic capture covers visible chat text, not
  hidden reasoning or raw tool output.
- Conversation cleanup targets 30 days and 2,500 chunks per scope.
- Redaction isn't foolproof — pause before sharing sensitive material.
- Retrieved passages are sent to your configured model.

## Docs

[Setting up your first agent](docs/FIRST-AGENT.md) ·
[Setup, updates & controls](docs/INSTALL.md) ·
[Agent-owned jobs](docs/CLOUD-JOBS.md) ·
[Local scheduled tasks](docs/LOCAL-SCHEDULED-TASKS.md) ·
[Non-Pinocchio job runner](docs/NON-PINOCCHIO-JOBS.md) ·
[Design](docs/DESIGN.md) ·
[Privacy](PRIVACY.md) ·
[Contributing](CONTRIBUTING.md) ·
[MIT license](LICENSE)
