# Pinocchio

**Copilot CLI agents that remember your conversations across sessions.**
Use your existing CLI and login. Each agent gets its own memory.

## 1. Install

You'll need Copilot CLI, Git, npm, and Node.js **22.18 or newer 22.x** on macOS or Linux.

```bash
git clone https://github.com/chiedo/pinocchio.git
cd pinocchio
npm ci
```

Keep this folder where it is: it supplies the agent's memory runtime.

## 2. Create an agent

For an agent you can use in any repository:

```bash
npm run setup -- --name builder --global
```

Or limit its memory to one project:

```bash
npm run setup -- --name reviewer --repository /absolute/path/to/your/project
```

Run setup from the Pinocchio folder. Change the name to create more agents.
Existing agent files are never overwritten.

## 3. Chat

Start a fresh CLI session and approve the Pinocchio extension if prompted:

```bash
copilot --agent builder
```

Talk normally. Close the session, start another with the same agent, and pick
up where you left off. **You don't need to say "remember this."** New conversations
are captured automatically; older chats are not imported.

Global agents work from any directory. Project-scoped agents must run in their
configured repository.

## Pause or remove memory

From the Pinocchio folder:

```bash
npm run setup -- --name builder --pause-conversation
npm run setup -- --name builder --resume-conversation
npm run setup -- --name builder --remove
```

Pause stops automatic capture and recall. Removal disconnects the agent's memory
tools after a restart; it preserves stored notes and the agent's other instructions.

**Preview:** recall isn't perfect. Automatic capture covers foreground user and
assistant text, not hidden reasoning or raw tool output. Conversation cleanup
targets 30 days and 2,500 chunks per scope. Redaction isn't foolproof: pause before
sharing sensitive material. Retrieved passages are sent to your configured model.

[Setup, updates, and controls](docs/INSTALL.md) ·
[Privacy](PRIVACY.md) · [Design](docs/DESIGN.md) ·
[Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
