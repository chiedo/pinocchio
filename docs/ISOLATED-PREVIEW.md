# Isolated developer preview

For your existing Copilot CLI, use [the simple setup](INSTALL.md).
This separate pinned runtime is for reproducible developer validation, not the
normal installation path.

**This is a preview, not a certified release.** The owner waived the missing #6
live-model gate to make experimentation possible. That gate remains unvalidated.
Desktop support is not advertised.

The normal CLI does not currently provide the extension pre-MCP metadata used by
the stronger SDK-driven accounting path. The preview therefore derives fallback
request context inside each immutable per-agent MCP process. Identity, scope,
argument integrity, the 800-byte call limit and a 6,000-byte process limit remain
enforced. The process limit is not shared across separate helper processes or
CLI restarts; this narrower boundary is explicit preview behavior.

## 1. Install once

Prerequisites: **Node.js 22.18.0**, npm, Git, and a Copilot account for your own
interactive sessions. Installation downloads locked npm packages, including a
separate public **Copilot CLI 1.0.83** and **SDK 1.0.13**. It does not patch or
replace your existing `copilot` command.

For this PR preview, from the source checkout:

```bash
gh pr checkout 16 --repo chiedo/pinocchio
npm ci
npm run build

# A separate profile keeps your normal CLI configuration untouched.
export CONFIG_ROOT="$HOME/.copilot-pinocchio-preview"

# Linux x64:
node dist/src/install-cli.js install --config-root "$CONFIG_ROOT"

# macOS ONLY: use this instead of the preceding install command.
# This explicitly opts into an unvalidated platform preview.
node dist/src/install-cli.js install --config-root "$CONFIG_ROOT" --preview-platform
```

Choose **one** install command. The installed copy records its source commit and
file hashes; subsequent edits or pulls in this checkout do not update that copy.
Before a published release, review and retain that exact commit rather than
treating the preview branch as a stable release.

Successful full CI runs also publish `cli-preview-linux-x64`, containing
`pinocchio-cli-preview.tgz` and `SHA256SUMS`. Download from a **specific reviewed
run**, verify with `sha256sum -c SHA256SUMS`, then extract the archive. In its
`pinocchio/` directory, run `npm ci --omit=dev --ignore-scripts` and the same
`node dist/src/install-cli.js install` command above. The internal `release.json`
records the commit and verifies payload hashes. Checksums detect corruption;
they are not independent publisher signatures. Artifacts expire after 14 days;
there is no published stable release or auto-update service.

Install checks the candidate runtime with **invented data in a temporary custom
configuration root**, using an unauthenticated loopback provider. It checks tools
before enrollment, sourced saves, fresh CLI-process recall, independent helpers,
and deletion. It makes no paid model calls and removes the synthetic state.
A failed check is an installation failure, not a successful install with a warning.

Keep this shortcut in each terminal you use (or add these two lines to your shell
configuration yourself):

```bash
export CONFIG_ROOT="$HOME/.copilot-pinocchio-preview"
export PINOCCHIO="$CONFIG_ROOT/pinocchio-runtime/pinocchio"
"$PINOCCHIO" status
```

No automatic embedding download occurs. The initial preview uses keyword search
with an explicit degradation reason. Optional hybrid setup is below.

## 2. Create each agent from a blank CLI session

Start in the Git repository the agent should remember:

```bash
cd /path/to/your/repository
"$PINOCCHIO" start
```

This starts a **new unnamed session**, not a resumed conversation. Sign in if the
new profile asks. Paste the following into that blank session, changing `builder`
to the name you want:

```text
Create a named Pinocchio agent called builder for the current Git repository.
Run:
"$COPILOT_HOME/pinocchio-runtime/pinocchio" create --name builder --repository "$PWD" --tools view,rg,glob,bash,apply_patch,task

Then edit "$COPILOT_HOME/agents/builder.agent.md":
- Give it a concise description and instructions for implementing and testing code.
- Preserve the generated Pinocchio memory block, MCP server, and memory tool entries exactly.
- Keep its explicit tool allowlist. Do not use wildcard tools or allow-all permissions.
- Do not set or change model settings unless I explicitly ask.
Do not store anything from this setup conversation as a memory.
```

Approve the command/profile edits normally. Exit that setup session, then start
the named agent in a **fresh session**:

```bash
"$PINOCCHIO" start --agent builder
```

For a second agent, open another blank session with `"$PINOCCHIO" start`. Paste
the same setup prompt with a different name and role, for example `reviewer`,
instructions to review code, and `--tools view,rg,glob,task` for a read-oriented
allowlist. Exit and run `"$PINOCCHIO" start --agent reviewer`.

**Each named definition gets its own memory.** Helpers delegated to that named
definition share that definition's memory, not the parent's. New unrelated
agents are not silently enrolled. A plain unnamed session is not a named memory
owner. A repository-scoped agent must be launched in that same repository.
Use `--global` **instead of** `--repository "$PWD"` only when you intentionally
want that agent's notes available across repositories.

Prefer terminal setup? The equivalent command is:

```bash
"$PINOCCHIO" create --name builder --repository "$PWD" \
  --tools view,rg,glob,bash,apply_patch,task
"$PINOCCHIO" start --agent builder
```

The create result includes the binding reference needed by administrative
commands. Existing files are never overwritten. Restart after profile changes.

## 3. Try memory across sessions

In `builder`, say:

> Remember this synthetic project fact: the demonstration release is called
> Copper Finch. Source: this explicit manual entry. Confirm whether the save committed.

Exit, run `"$PINOCCHIO" start --agent builder` again, and ask:

> Search your memory: what is the demonstration release called? Cite the stored source.

Try the same question in `reviewer`: it should not receive `builder`'s record.
Search/save invocation by a real model remains **best-effort**, not guaranteed.
An unavailable tool or unknown save outcome must not be described as success.

## Controls and optional hybrid search

```bash
"$PINOCCHIO" disable
"$PINOCCHIO" enable
"$PINOCCHIO" doctor                  # Linux x64
"$PINOCCHIO" doctor --preview-platform  # macOS opt-in
```

Disable preserves records and profiles; it stops managed scopes' model reads and
writes. Enable preserves a scope that was already disabled before the installer
disabled it. Administrative inspection remains available.

For local embeddings, create a separate private environment:

```bash
python3.12 -m venv "$CONFIG_ROOT/pinocchio-python"
"$CONFIG_ROOT/pinocchio-python/bin/pip" install \
  -r "$CONFIG_ROOT/pinocchio-runtime/app/semantic/requirements.txt"
"$PINOCCHIO" semantic prepare --python "$CONFIG_ROOT/pinocchio-python/bin/python"
```

This **explicitly downloads** 23,684,031 bytes of pinned Apache-2.0 MiniLM
model/tokenizer assets. Python packages need additional disk space; allow
approximately 1 GiB RAM for query/build processes. Model hashes are verified.
See [SEMANTIC.md](SEMANTIC.md) for the pinned versions, limits and cache behavior.
Python wheel dependencies are version-pinned; npm dependencies additionally use
the integrity-checked lockfile. macOS hybrid retrieval is not certified.

The launcher also forwards `bindings`, `memory`, and `semantic` commands:
use the exact binding/fingerprint, namespace and scope returned during setup.
See [STORAGE.md](STORAGE.md) for inspect, correct, operation-status and
**single-record `memory forget`** commands. Deletion is a separate scoped action;
there is intentionally no blanket erase command.

## Upgrade, rollback and uninstall

Exit **all** CLI sessions using this installation before changing its runtime.
Build a reviewed, pinned new source checkout, then run its installer:

```bash
node dist/src/install-cli.js upgrade --config-root "$CONFIG_ROOT" --host-stopped
# Append --preview-platform on macOS.
"$PINOCCHIO" rollback --host-stopped
"$PINOCCHIO" discard-previous --host-stopped
"$PINOCCHIO" uninstall --host-stopped
```

Upgrade retains one previous runtime. Rollback swaps it back; discard-previous
removes only that old runtime and is required before another upgrade. Only
storage-schema version 1 is accepted: these commands do **not** migrate data or
promise rollback across future schema changes. Existing profiles use the stable
installed runtime path. A new runtime must pass its synthetic check before use.

Uninstall removes managed memory configuration and installed runtime code, while
preserving profile files, later unrelated profile edits, native configuration,
binding metadata, records, models and indexes. Modified managed blocks/servers
cause a visible conflict rather than destructive overwriting. Reinstalling does
not automatically re-enroll preserved profiles.

Layout:

```text
source checkout/                         Build input, not the active runtime
<config-root>/pinocchio-runtime/app/     Installed locked CLI + Pinocchio code
<config-root>/pinocchio-runtime/previous/ One rollback copy, when present
<config-root>/pinocchio/                 Private bindings/context/model settings
<config-root>/agent-memories/            Private records and derived indexes
<config-root>/agents/                    Your editable named profiles
```

No command changes native memory or model settings or broadens host permissions.
Recalled snippets enter your configured model's context. Same-user shell/file
access is not isolated by tool namespaces. Forgetting a note cannot retract
previously sent context, provider logs or backups; see [PRIVACY.md](../PRIVACY.md).

## Troubleshooting and support boundary

| Result | Action |
|---|---|
| `NODE_22_18_0_REQUIRED` | Select Node 22.18.0, then retry; do not patch the host. |
| `PLATFORM_UNVALIDATED` | Only Linux x64 is the default baseline; macOS requires explicit preview opt-in. Windows is unsupported. |
| `INSTALL_DIAGNOSTIC_FAILED_*` | Installation is blocked at the named synthetic stage. Report only that code and public versions. |
| `EXPLICIT_NAME_AND_SCOPE_REQUIRED` | Choose a unique lowercase name and exactly one repository/global scope. |
| `PROFILE_*` / `MANAGED_*` / `CONTEXT_EXTENSION_CONFLICT` | Preserve the file and resolve only the managed conflict; never overwrite the whole profile. |
| `INSTALLER_BUSY` | Another installer owns the lock. After confirming that PID has exited, remove only `<config-root>/pinocchio-runtime/installer.lock`. |
| Interrupted upgrade/rollback | Keep sessions stopped. Preserve `app`, `previous`, and `install.json`; inspect their `release.json` identities before recovery. Do not delete memory directories. |
| Keyword degradation / exhausted budget / outcome unknown | See [MEMORY-TOOLS.md](MEMORY-TOOLS.md); retry saves with the same operation ID, not a new write. |

**Desktop NO-GO for this preview:** no independently verified public desktop
configuration establishes extension loading, runtime/data location, trusted
helper identity and restart/recall together. A CLI doctor pass is not desktop
evidence. No desktop setup commands, Windows support, remote synchronization or
hosted-app support are advertised.
