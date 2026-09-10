# Installation and compatibility

## Current status

**There is no production installer.** The source provides
a [configuration-bound identity layer](BINDINGS.md), verified on public
CLI 1.0.83 / Linux x64. `npm run bindings -- bind ...` registers a canonical
definition and explicit scope, returning an agent-specific MCP launch
configuration. It does not edit profiles or create memory records.
The separate [local storage CLI](STORAGE.md) can create and manage durable records
after an explicit binding and namespace/scope selection.
The [development enrollment helper](MEMORY-TOOLS.md) wires named profiles to
scoped keyword-memory tools and a shared trusted-context extension.

`npm ci` and `npm run build` build the source-checkout diagnostics; they do not
enable memory or install a user-level extension. The entry is
`.github/extensions/pinocchio/extension.mjs`, loaded by an extension-capable host
after building. The automated public-host reproduction is documented in the
compatibility report. Building alone does not enroll profiles. Development
enrollment is explicit and recall remains best-effort, not automatic or guaranteed.

## Get the source and plan

These commands clone the public project. They do not install or enable memory:

```sh
git clone https://github.com/chiedo/pinocchio.git
cd pinocchio
```

Start with [DESIGN.md](DESIGN.md). No credentials or local memory exports need to
be added to the checkout.

## Intended supported hosts

| Host | Status | Requirement before claiming support |
|---|---|---|
| GitHub Copilot CLI | Pinned 1.0.83 / Linux x64 development baseline; identity, SQLite and keyword-memory integration | Semantic retrieval, release evaluations and packaging remain separate gates. |
| GitHub Copilot desktop app | Planned, separately gated | Verify the app loads the integration, exposes the required tool/caller metadata, and uses the intended local runtime and data directories. |
| GitHub web, GitHub Mobile, hosted GitHub Apps | Out of scope | Local CLI installation does not establish access from these hosts. |

The identity-only baseline is not a memory release or a desktop support claim.
macOS, Linux and Windows must each be listed as supported only after validation.
Compatibility with one host or machine must not be generalized to everyone.

If a desktop app uses a remote runtime, it must not be assumed to see the local
machine's files or installed extensions. Packaging, runtime selection, permissions
and tool behavior need explicit verification even when products share components.

## Planned installation flow

The first release must replace this roadmap with exact, executable instructions.

1. **Check prerequisites.** Report supported host versions, platforms, runtimes
   and capabilities. Explain missing requirements instead of silently continuing.
2. **Install a pinned release.** Install the integration and its locked
   dependencies into the selected host's supported user-level location. Do not
   patch the CLI distribution or change global permissions.
3. **Set up local retrieval.** Explain which embedding model is downloaded, where
   it is cached, its license, storage requirements and any supported keyword-only
   mode. Do not hide network downloads behind a successful-install message.
4. **Enroll named agents.** Preserve their existing instructions, tools and model
   settings. Add the shared memory instruction only after memory tools are
   available. Explain how new agents receive the same default.
5. **Confirm behavior with synthetic data.** A diagnostic should demonstrate a
   sourced save, new-session recall, independent helper namespaces and deletion.
   Never request real memories or private prompts for this check.
6. **Explain status and controls.** Show how to inspect sources, correct or forget
   a record, resolve an interrupted save, and disable the extension.

Illustrative Unix-style layout, not a command to execute:

```text
source checkout/                         Version-controlled code
~/.copilot/extensions/pinocchio/          Installed runtime, if supported by host
~/.copilot/agent-memories/{agent-name}/   Private memory records and derived indexes
```

The installer must resolve the actual host configuration directory, including
custom locations. Native Windows paths and platform-specific instructions must be
documented before Windows support is advertised.

## Upgrades and rollback

Planned requirements:

- Pin and identify the installed code version; do not automatically run arbitrary
  changes from a moving repository branch.
- Preserve memory data when replacing code. Explain schema migrations and
  supported rollback boundaries before applying them.
- Treat vector indexes as rebuildable caches. Embedding-model or schema changes
  must not silently query an incompatible index.
- Keep any explicitly requested backup outside the repository and label it as
  private runtime data.
- Recheck host capabilities after upgrades; unsupported integration must fail
  visibly rather than guess an agent identity.

## Disable and uninstall

The eventual guide must provide separate, working instructions for:

- **Disable:** stop Pinocchio reads/writes while preserving installed code and data.
- **Uninstall:** remove installed code and managed enrollment changes without
  erasing memories or unrelated profile edits.
- **Delete data:** require an explicit, scoped request to remove memory records.

None of these operations should imply deletion of native Copilot memory/history,
already-sent model context, or external backups.

## Troubleshooting requirements

Diagnostics should distinguish unsupported host, missing tools, unknown caller
identity, unavailable worker, no search match, degraded keyword-only retrieval,
budget exhaustion and save outcome-unknown.

Public bug reports must use synthetic reproductions and public version
information. Do not upload authentication files, a whole home directory, real
memory databases, raw session logs or private-project details.
