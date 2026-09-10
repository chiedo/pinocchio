# Pinocchio

Turn each copilot session into a real boy. Memory and all!

Pinocchio is a planned local memory extension for named GitHub Copilot CLI
agents. Each agent would keep its own knowledge across sessions, including when
another agent delegates work to it.

**Identity layer implemented; memory tools are next.** The
[configuration-bound identity gate](docs/COMPATIBILITY.md) passes on public
Copilot CLI 1.0.83 / Linux x64. Agent-specific MCP servers resolve stable
definition namespaces and explicit repository/global scopes using a private
binding registry. Invalid, revoked and stale bindings fail closed.
There is no memory storage, profile enrollment or production installer yet.

## The idea

- Independent memory for each named agent, not one shared store for every helper.
- Memory search and save instructions in each enrolled agent's `.agent.md`.
- Local SQLite records with bounded keyword and semantic retrieval.
- Native per-agent model defaults; no separate agent orchestrator.
- Inspectable sources, corrections, deletion, and a disable switch.

Search invocation would be best-effort: instructions encourage the agent to call
the memory tool, but do not guarantee a lookup before every answer.

## Installation and compatibility

Read the [installation guide](docs/INSTALL.md) for the current status, source
checkout instructions, planned setup flow, and release requirements.

| Host | Current Pinocchio support |
|---|---|
| GitHub Copilot CLI | Configuration-bound identity verified on 1.0.83 / Linux x64; no released memory product. |
| GitHub Copilot desktop app | Targeted; requires separate compatibility validation. |
| GitHub web, GitHub Mobile, or a hosted GitHub App | Not targeted by this local extension design. |

CLI support alone will not be presented as proof of desktop-app support.
The app must expose the required local extension, tool, and agent-identity
capabilities, and use the intended local data store.

## Documentation

- [Complete design, acceptance criteria, and confidence assessment](docs/DESIGN.md)
- [Identity compatibility report and development commands](docs/COMPATIBILITY.md)
- [Binding registration, revocation and MCP configuration](docs/BINDINGS.md)
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
