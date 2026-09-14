# 🤥 Pinocchio

**Copilot CLI agents where each agent gets its own memory and remembers your conversations across sessions. Built to be used in [Herdr](https://herdr.dev/).**

<img width="2014" height="1338" alt="Screenshot 2026-09-14 at 4 20 33 PM" src="https://github.com/user-attachments/assets/2c681738-274b-4acf-9144-142b2ae25c9e" />


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
Setup preserves your custom instructions.

## 3. Give your agent instructions

**Edit the `profile` file printed by setup.** For `builder`, this is normally
`~/.copilot/agents/builder.agent.md`. This file defines the agent's role and
behavior; you don't need a separate `AGENTS.md`.

Replace the default "Follow the user's instructions." text **below the YAML
frontmatter and above the generated Pinocchio memory block** with your own:

```markdown
You are a software engineer.

- Read the existing code before making changes.
- Implement focused fixes and add relevant tests.
- Explain what changed and any remaining risks.
```

You can also edit the YAML `description` and model settings. **Keep the generated
`mcp-servers`, Pinocchio tool entries, and memory block intact.** Don't move or
rename the profile: its path is part of its memory identity.

Repository `AGENTS.md` files still supply project instructions; they are separate
from this agent profile. Start a fresh session after editing the profile.

**Each agent knows its own name, exact profile path, memory scope, and how its
configuration works.** Ask "Where is your agent file?" or "How do I change your
instructions?" For an existing agent, rerun its original setup command after
updating Pinocchio; this refreshes the generated guidance without changing your
custom instructions or memory binding.

**Rules for all Pinocchio agents:** setup creates
`~/.copilot/pinocchio/AGENTS.md` (under your configuration root if customized).
Every enrolled profile tells foreground and delegated agents to read it at session
start. Agents default instruction edits to their **own profile**; they should
only edit the shared file when you explicitly request an all-agent rule.
Setup preserves your shared rules. See [updating existing sessions](docs/INSTALL.md#shared-instructions-and-live-sessions).

## 4. Chat

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
