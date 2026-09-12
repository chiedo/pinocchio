# Pinocchio

Turn each copilot session into a real boy. Memory and all!

Pinocchio is a development-stage local memory integration for named GitHub Copilot CLI
agents. Each agent keeps its own knowledge across sessions, including when
another agent delegates work to it.

**Scoped memory tools, local hybrid retrieval, durable storage and reversible enrollment are implemented.** The
[configuration-bound identity gate](docs/COMPATIBILITY.md) passes on public
Copilot CLI 1.0.83 / Linux x64. Agent-specific MCP servers resolve stable
definition namespaces and explicit repository/global scopes using a private
binding registry. Invalid, revoked and stale bindings fail closed.
The [local administrative CLI](docs/STORAGE.md) supports sourced notes, search,
correction, deletion, disable controls and durable retry recovery.
[Agent memory tools](docs/MEMORY-TOOLS.md) add bounded worker execution and
persistent per-request/session limits. [Optional local semantic retrieval](docs/SEMANTIC.md)
adds pinned embeddings and rebuildable FAISS indexes. The simple setup adds a
memory extension and named agent to your existing Copilot CLI configuration.
Live-model release certification remains unvalidated.

## The idea

- Independent memory for each named agent, not one shared store for every helper.
- Memory search and save instructions in each enrolled agent's `.agent.md`.
- Local SQLite records with bounded keyword and semantic retrieval.
- Native per-agent model defaults; no separate agent orchestrator.
- Inspectable sources, corrections, deletion, and a disable switch.

Search invocation would be best-effort: instructions encourage the agent to call
the memory tool, but do not guarantee a lookup before every answer.

## Installation and compatibility

From a persistent checkout, run `npm ci`, then
`npm run setup -- --repository /absolute/path/to/your/project`.
Restart your normal CLI and select `/agent pinocchio`.
See [installation and removal](docs/INSTALL.md). No separate login or launcher.

| Host | Current Pinocchio support |
|---|---|
| GitHub Copilot CLI | Existing-CLI preview on Linux/macOS; setup verifies memory tool connectivity. Live-model certification remains unvalidated. A separate pinned developer harness is available. |
| GitHub Copilot desktop app | Unsupported/unvalidated; CLI results do not establish desktop support. |
| GitHub web, GitHub Mobile, or a hosted GitHub App | Not targeted by this local extension design. |

CLI support alone will not be presented as proof of desktop-app support.
The app must expose the required local extension, tool, and agent-identity
capabilities, and use the intended local data store.

## Documentation

- [Complete design, acceptance criteria, and confidence assessment](docs/DESIGN.md)
- [Identity compatibility report and development commands](docs/COMPATIBILITY.md)
- [Binding registration, revocation and MCP configuration](docs/BINDINGS.md)
- [Local memory commands, recovery and migrations](docs/STORAGE.md)
- [Agent memory tools, context limits and reversible enrollment](docs/MEMORY-TOOLS.md)
- [Local semantic retrieval, setup and index recovery](docs/SEMANTIC.md)
- [Installation, upgrades, and uninstall](docs/INSTALL.md)
- [Privacy and public-data policy](PRIVACY.md)
- [Contributing](CONTRIBUTING.md)

## Privacy first

**Do not contribute personal data, credentials, real memories, raw session logs,
or private-project details.** Public examples and fixtures must be synthetic.
Runtime databases and indexes belong outside the repository.

Local storage does not mean offline inference: recalled snippets would be sent
to the configured model as part of the agent's context. Existing Copilot memory,
history, and provider policies remain separate. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE).
