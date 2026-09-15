# Privacy and public-data policy

Pinocchio is a public repository. It contains an identity binding layer and a
local SQLite store and scoped keyword-memory tools. Binding metadata includes
local definition/repository paths and belongs outside the checkout; never upload
the private registry. Memory content, evidence paths, databases and journals also
belong outside the checkout. The requirements below govern contributions and future work.
The context ledger contains hashed execution IDs, request timestamps, usage and
delivery metadata; its signing key is private. Neither belongs in public
artifacts. Recalled snippets enter the configured model's context.
Optional embeddings run locally; model preparation downloads only pinned public
artifacts. Vector generations are private, rebuildable data. Forgotten vectors
may remain on disk or in process caches until cleanup, but SQLite revision/status
checks prevent their return. See [semantic cleanup](docs/SEMANTIC.md#forget-and-cleanup).

## What may be published

- Generic source, documentation, schemas, and migrations.
- Synthetic agent profiles, records, conversations, and test fixtures.
- Dependency and project references that are already public.
- Reproduction instructions using a clean temporary workspace and invented data.

## What must stay out

- Names, private email addresses, contact details, or other personal data in
  examples, fixtures, issues, diagnostics, or documentation.
- Credentials, tokens, cookies, certificates, private keys, or authentication files.
- Real memory records, vector indexes, conversations, screenshots, or raw logs.
- Personal home paths, live session IDs, device identifiers, or account exports.
- Private repository links, internal project names, customer information, or
  employer-confidential code and product details.
- Private-build observations presented as public compatibility guarantees.

Use generic paths such as `~/.copilot/agent-memories/example-agent/`. Invent data
from scratch rather than lightly redacting a real transcript.

The project's own public repository address and public dependency references are
not examples of private-project disclosure. Git attribution should use a public
alias and a GitHub-provided noreply address, not a private email or legal name.

## Runtime boundaries and future model integration

| Boundary | Requirement |
|---|---|
| Storage | Keep memories and indexes outside the source checkout, with restrictive local permissions. |
| Ownership | Derive agent namespace and repository scope from trusted runtime identity, not a model-supplied agent name. |
| Collection | Selected enrolled foreground agents capture new user/assistant text by default. Exclude tool output, hidden reasoning, attachments, and system-injected messages. No transcript backfill. Pause automatic capture and recall through the setup command. |
| Sensitive content | Exclude secrets and sensitive personal information. Do not claim detection or redaction is infallible. |
| Model access | Explain that retrieved snippets enter the configured model's context. Local persistence is not offline inference. |
| Telemetry | No Pinocchio memory-upload service or outbound telemetry by default. Host/provider behavior is separate. |
| Optional cloud jobs | Publish only after an exact preview and explicit approval. Export the selected `~/.copilot/agents/<agent-name>.agent.md` without Pinocchio memory wiring, local skills or MCP configuration. Never upload memory/history automatically. Prompts, exported instructions, logs and results in the configured private repository are cloud data. |
| Diagnostics | Prefer status codes, public version numbers and aggregate counters; no raw note or prompt content by default. |
| Deletion | Remove the selected record's content revisions and stop its return through indexes or queued work. |

Automatic conversation records are labelled with their speaker and timestamp;
assistant content is tentative evidence, not a confirmed fact. Known credential
patterns, email addresses, and identifier patterns are redacted before storage.
This is not a comprehensive sensitive-content detector. Pause conversation
memory before discussing private material you do not want retained.
Retention cleanup during capture targets 30 days and 2,500 conversation chunks
per scope; it is not an always-running deletion service. Curated notes remain
under explicit user control. See [conversation controls](docs/INSTALL.md#conversation-controls).

Deleting a Pinocchio record cannot remove content already delivered to a model,
native Copilot memory/history, external backups, or other processes' copies.
Physical cache cleanup may lag logical deletion and must be reported separately.
Secure erasure from storage hardware is not promised.

Tool-level scoping is not an OS sandbox. A process that already has permission to
read local files may be able to access the underlying data. Administrative
commands are governed by local permissions, not by proof that a human typed them.

## Before publishing

Review staged file contents, filenames, commit attribution, issue text and
attachments. `.gitignore` reduces accidents but is not a data-loss prevention
system and does not remove already tracked files or Git history.

If sensitive data is found, stop publication. Do not paste it into a public issue.
For a credential exposure, revoke or rotate the credential through its provider;
deleting a visible file alone does not address copies or history.
