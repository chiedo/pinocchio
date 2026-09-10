# Configuration-bound identity

This is the identity layer, not memory storage or profile enrollment.
The public host's shared-extension diagnostic remains fail-closed. A separately
configured MCP server resolves its immutable local binding instead of guessing
which agent called a shared tool.

## Local administrative interface

Build with Node 22.18.0:

```sh
npm ci
npm run build
```

Register a file-backed agent definition and an explicit scope:

```sh
npm run bindings -- bind \
  --definition /workspaces/example/.github/agents/researcher.agent.md \
  --origin project \
  --origin-root /workspaces/example/.github/agents \
  --repository /workspaces/example
```

For a global binding, replace `--repository ...` with `--global`. They are
mutually exclusive. Supported definition origins are `project`, `user` and
`plugin`; `--origin-root` must contain the definition's canonical path.
Remote/anonymous definitions are not supported.

The command returns a `reference` and an `mcpServer` configuration. It does not
edit profiles or turn on memory. Trusted local setup must attach that server
only to the intended agent, with an explicit tool allowlist. Do not install all
agents' servers as shared session-level MCP servers or grant unrestricted tool
inheritance. This constraint is part of the identity boundary, not merely a UX
recommendation.

Use the returned values for these commands:

```sh
npm run bindings -- status --config-root /private/example-config \
  --binding BINDING_ID --fingerprint FINGERPRINT
npm run bindings -- revoke --config-root /private/example-config \
  --binding BINDING_ID --fingerprint FINGERPRINT
```

`BINDING_ID` and `FINGERPRINT` are placeholders, not working sample credentials.
They are metadata integrity references, not secrets or an OS authorization
mechanism. `status` exits nonzero for an unavailable binding. `revoke` is
idempotent and affects exactly the referenced binding; repository and global
bindings can be revoked independently.

The generated server command runs `serve` with the same reference. Its only
tool is `identity_status()`, with no owner, namespace or scope arguments. Missing,
unknown, revoked, tampered or stale bindings produce an explicit unavailable
tool result, not a fallback to another agent.

## Stable identity and private registry

Configuration root precedence is explicit `--config-root`, then
`COPILOT_CONFIG_DIR` / `COPILOT_HOME`, then `~/.copilot`. Conflicting environment
roots require an explicit choice. The canonical root is pinned into the
generated launch configuration.

Metadata lives in `<config-root>/pinocchio/bindings/`. Registry directories use
mode `0700`, records use `0600`, and existing unsafe permissions or symlinked
registry entries are rejected. Records contain local definition/repository paths
but no prompts or memory content. Do not upload this directory. Only Linux is
covered by the public-host gate; macOS uses the same Unix permission checks but
is not certified by that gate. Windows is explicitly unsupported until ACL
handling is implemented and validated.

Definition IDs hash the canonical origin, origin root and definition path.
Namespaces combine a sanitized filename with the full SHA-256 definition ID.
Duplicate names, sanitization collisions and different origins remain separate.
Prompt, display-name and model edits at the same path preserve identity.
Renames/moves create a different identity and require an explicit migration in
future storage tooling; this layer never silently moves records.

Repository scopes use the canonical Git top-level path, separate from `global`.
Bindings also pin the repository directory and Git metadata filesystem identities
so replacement invalidates a live registration. Rebinding a moved/replaced
repository is explicit; no implicit migration is performed.

Each registration has a unique immutable record and a fingerprint supplied
through trusted launch configuration. Concurrent registrations do not overwrite
one another. The definition namespace remains stable across registrations;
the registration ID is a lifetime handle, not the memory owner. Registration
acknowledgement follows file and directory synchronization. Revocation creates
a durable marker and never redirects the old handle.

## Adapter contract

`BoundIdentityAdapter.withIdentity(operation, signal)` supplies a frozen
definition/namespace/scope snapshot, with an abort signal. It validates the
registry, definition and scope before work and again before returning a result.
Revocation, changes to the pinned record, repository replacement, cancellation
or disposal prevents a successful result. The whole operation has a 900 ms
budget, reserving headroom under the proposed one-second backend deadline.
Late completions are discarded, not delivered or rerouted.
Operations must remain asynchronous/nonblocking; the adapter is not a worker
thread and cannot preempt synchronous code that blocks the event loop.

The final validation is the read-result linearization point; revocation cannot
recall a response already delivered. The adapter does **not** undo operation side
effects. Future storage must validate before committing and preserve explicit
outcome-unknown handling when a commit succeeds but its acknowledgement is
cancelled or times out. That transactional contract belongs to issue #3.

`identity_status` returns opaque identity and scope keys, not local paths.
Failures expose fixed codes rather than exception text or host traces.
The MCP server uses the public MCP SDK; it has no model, prompt-injection,
sampling, delegation, storage or telemetry hooks.

## Development and format changes

`npm test` runs all registry, CLI, MCP and real public-host tests with synthetic
definitions and an invented local model provider. CI publishes only aggregate
gate reports. See [COMPATIBILITY.md](COMPATIBILITY.md) for measured results.

Registry schema version 1 is strict; unknown versions are rejected. There is no
automatic migration or downgrade. Revoked handles stay revoked after restart.
Keep existing immutable metadata and explicitly register replacement bindings
when configuration changes. Profile installation/removal is deferred to issue #4;
memory records and their migration/rollback policy are deferred to issue #3.
