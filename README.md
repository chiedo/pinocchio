# 🤥 Pinocchio

**Give your Copilot CLI agents a memory.** Each named agent remembers what it
learned in past conversations — your preferences, decisions, and unfinished
work — so you stop re-explaining context every session. Built to be used in
[Herdr](https://herdr.dev/).

<img width="2014" height="1338" alt="Pinocchio agent memory screenshot" src="https://github.com/user-attachments/assets/2c681738-274b-4acf-9144-142b2ae25c9e" />

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

## Requirements

- macOS or Linux
- [Copilot CLI](https://github.com/github/copilot-cli), Git, npm
- Node.js **22.18–22.x**

## Quick start

```bash
git clone https://github.com/chiedo/pinocchio.git
cd pinocchio
npm ci
```

Keep this folder where it is — it supplies the runtime every enrolled agent uses.

### 1. Create an agent

Global (usable in any repo):

```bash
npm run setup -- --name builder --global
```

Or scoped to one project:

```bash
npm run setup -- --name reviewer --repository /absolute/path/to/your/project
```

Change `--name` to create more agents. Setup preserves any custom instructions
already in an existing profile.

### 2. Give it instructions

Edit the profile path printed by setup (for `builder`, normally
`~/.copilot/agents/builder.agent.md`). Replace the default text **below the
YAML frontmatter and above the generated Pinocchio memory block**:

```markdown
You are a software engineer.

- Read the existing code before making changes.
- Implement focused fixes and add relevant tests.
- Explain what changed and any remaining risks.
```

Keep the generated `mcp-servers`, tool entries, and memory block intact, and
don't move or rename the file — its path is part of its memory identity.

### 3. Chat

```bash
copilot --agent builder
```

Approve the Pinocchio extension if prompted, then talk normally. Close the
session, start another with the same agent, and it picks up where you left
off.

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

[Setup, updates & controls](docs/INSTALL.md) ·
[Design](docs/DESIGN.md) ·
[Privacy](PRIVACY.md) ·
[Contributing](CONTRIBUTING.md) ·
[MIT license](LICENSE)
