# Add Pinocchio to your existing Copilot CLI

**Use your normal `copilot`. No second CLI, separate login, or launcher.**
Pinocchio installs a memory extension and a named agent with its own memory tools.
It is not a skill-only installation.

## Install

Requires an existing `copilot` on PATH, Node.js 22.18 or newer **22.x**, and npm.
Linux and macOS are preview targets; live-model certification remains unvalidated.

Clone this repository into a location you will keep, then run:

```bash
npm ci
npm run setup -- --repository /absolute/path/to/your/project
```

This creates the `pinocchio` agent in your existing Copilot configuration
(normally `~/.copilot`), scoped to that Git repository. It does not overwrite
existing agent files or change your login, model, native memory, or permissions.
For another name, append `--name builder`. For intentionally cross-repository
memory, use `--global` instead of `--repository`.

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

## Update or remove

Exit sessions using Pinocchio before rebuilding. From this checkout:

```bash
git pull --ff-only
npm ci
npm run setup -- --repository /absolute/path/to/your/project
```

Repeat the original name and scope. Re-running setup checks the existing
binding rather than creating a second agent.

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

The normal CLI path uses per-agent MCP fallback accounting when extension
request metadata is unavailable: 800 bytes per call and 6,000 bytes per MCP
process, not a shared budget across helper processes or restarts. Keyword
search works without downloading embeddings. See [optional semantic search](SEMANTIC.md),
[memory administration](STORAGE.md), and [privacy](../PRIVACY.md).

The [isolated developer preview](ISOLATED-PREVIEW.md) retains the pinned CLI,
synthetic diagnostic gate, runtime snapshots, and rollback workflow. These are
not prerequisites for trying Pinocchio in your existing CLI.
