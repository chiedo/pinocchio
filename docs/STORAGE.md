# Local memory administration

The authoritative store is
`<config-root>/agent-memories/<stable-definition-namespace>/memories.sqlite`.
Repository/global partitions share that definition's database, not each other's
records. Same-named definitions have different hashed namespaces. Configuration
root precedence and immutable binding registration are described in [BINDINGS.md](BINDINGS.md).

This is a local administrative API/CLI, **not model-facing tools or automatic
collection**. Nothing edits agent profiles, changes model settings or installs an
extension. It uses Node 22.18.0's built-in SQLite (which may print an experimental
warning). Linux CI is the validated baseline; desktop/other-platform support
remains separately gated.

## Runnable synthetic example

From a built checkout (`npm ci && npm run build`), use an existing synthetic Git
repository and a synthetic `.agent.md` definition. Keep all data outside the
Pinocchio checkout. The following Bash example creates an isolated fixture:

```bash
DEMO="$(mktemp -d)"
mkdir -m 700 "$DEMO/config" "$DEMO/repo" "$DEMO/agents"
git init -q "$DEMO/repo"
printf '%s\n' '---' 'name: example' 'description: Synthetic fixture' '---' \
  'Use only explicitly configured tools.' > "$DEMO/agents/example.agent.md"
node dist/src/bindings-cli.js bind --config-root "$DEMO/config" \
  --definition "$DEMO/agents/example.agent.md" --origin user \
  --origin-root "$DEMO/agents" --repository "$DEMO/repo" > "$DEMO/binding.json"
BINDING="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).reference.bindingId' "$DEMO/binding.json")"
FINGERPRINT="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).reference.fingerprint' "$DEMO/binding.json")"
node dist/src/bindings-cli.js status --config-root "$DEMO/config" \
  --binding "$BINDING" --fingerprint "$FINGERPRINT" > "$DEMO/identity.json"
NAMESPACE="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).identity.namespace' "$DEMO/identity.json")"
memory() {
  node dist/src/memory-cli.js "$@" --config-root "$DEMO/config" \
    --binding "$BINDING" --fingerprint "$FINGERPRINT" \
    --namespace "$NAMESPACE" --scope repository
}
printf '%s\n' '{"content":"Synthetic cobalt identifier ABC-123","kind":"fact","evidence":[{"kind":"manual_entry","reference":{"type":"text","value":"invented example"}}]}' \
  > "$DEMO/note.json"
memory remember --input "$DEMO/note.json" --operation example-save > "$DEMO/receipt.json"
RECORD="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).recordId' "$DEMO/receipt.json")"
memory list
memory search --query ABC-123
memory inspect --record "$RECORD"
memory correct --record "$RECORD" --expected-revision 1 \
  --input "$DEMO/note.json" --operation example-correction
memory operation --operation example-correction
memory forget --record "$RECORD" --expected-revision 2 --operation example-forget
memory disable --operation example-disable
memory status
memory enable --operation example-enable
```

Use `--global` instead of `--repository` when registering an intentionally global
binding, and `--scope global` on its memory commands. `--namespace` and `--scope`
are **assertions**, not routing overrides: they must match the trusted binding.
A binding for a different repository is required to access that partition.
Re-registering the same definition/scope preserves its store; revocation disables
that launch reference, not every other authorized registration.

`npm run memory -- <command> ...` is an equivalent development entry point.
Input accepts `--input -` for stdin or a JSON file (128 KiB maximum), avoiding
note content in command arguments. Do not put sensitive search queries in shell
history. Exit 0 means a successful result, including explicit `no_match` or
`not_found`; errors use exit 1 and a fixed JSON error code on stderr.

| Command | Additional flags |
|---|---|
| `remember` | `--input`, `--operation` |
| `correct` | `--record`, `--expected-revision`, `--input`, `--operation` |
| `forget` | `--record`, `--expected-revision`, `--operation` |
| `list` | Optional `--limit`, `--offset` |
| `search` | `--query`; optional `--limit`, `--offset` |
| `inspect` | `--record`; optional `--limit`, `--offset` for revisions |
| `operation` | `--operation` |
| `status` | None |
| `disable` / `enable` | `--operation` |

Limits default to 20 and cap at 100; offsets cap at 1,000,000. `inspect` includes
source evidence and historical revisions. `list` includes superseded records;
search returns only active/tentative current revisions. Search matches literal
normalized substrings or all normalized query terms, ranking literal matches
first. Results are ordered deterministically by update time and ID. This
administrative interface returns full notes, not model-budgeted snippets.

## Evidence and schema

Required input: `content` (1–32,768 characters), `kind`
(`fact`, `decision`, `preference`, `procedure`, `todo`, `other`) and 1–8 evidence
entries. Optional `status` is `active` (default), `tentative` or `superseded`;
`sourceAt` and `confirmedAt` are ISO timestamps. Confirmation cannot precede
the supplied source time. Server-generated recording time is separate.

Each evidence entry has `kind` (`user_statement`, `tool_observation`,
`assistant_inference`, `manual_entry`) and `reference: {type, value}`:

- `url`: HTTP(S) syntax only; embedded credentials rejected; no network request.
- `file`: exists as a regular file at save time; canonical repository references
  must remain within the bound repository. Global file references must be absolute.
- `text`: an explicitly unverified source label.

Derived validation labels do **not** verify truth. Content is preserved exactly;
only keyword copies are Unicode-normalized/lowercased. No transcript collection,
automatic sensitive-data detector, embeddings, inference or telemetry is added.

Schema v1 has owner metadata, per-scope disable state, stable record/tombstone
metadata, append-only content/evidence revisions, current keyword entries and
terms, content-free indexing jobs, and a durable scoped operation ledger.
Index jobs reserve embedding-model/version and indexed-revision metadata for
future workers; no semantic worker runs in this step. Corrections cancel old
pending jobs and replace current keywords in the same transaction.

## Transactions, retries and acknowledgement

Every mutation requires a caller-chosen operation ID (1–128 letters, digits,
`.`, `_`, `:`, `-`; first character alphanumeric). Generate a fresh opaque ID per
intended operation, persist it before calling, and never encode note content in
it. Identical retries return the original metadata receipt; changed payloads
under the same ID return `OPERATION_CONFLICT`. The ledger is scoped, so another
repository cannot probe these IDs. Corrections/deletions compare
`--expected-revision` inside the writer transaction; stale writes return
`REVISION_CONFLICT` with the current revision.

SQLite `BEGIN IMMEDIATE`, foreign keys, DELETE journals and `synchronous=FULL`
cover record, revision, keyword, index-job and receipt writes together.
Writer contention returns `STORE_BUSY` after a 250 ms SQLite busy timeout;
retry the same operation ID. The API also rejects concurrent calls on one
instance explicitly. Both reads and writes take the scoped transaction and
validate the live binding and store identity before work and before commit.
Post-commit validation failures suppress the normal acknowledgement.

`committed` is emitted only after commit. A failed acknowledgement reports
`OUTCOME_UNKNOWN` with the operation ID when stderr remains usable. If the
process dies or both output channels fail, the caller must treat the missing
receipt as unknown. Use `operation --operation ID`, or retry the identical
mutation. `not_found` means no committed ledger entry was visible at lookup;
it does not prove another writer cannot still commit. A committed operation
whose record was forgotten reports only content-free historical metadata.

`acknowledge()` is the API's output-delivery wrapper. Do not equate a thrown
post-commit error with a rolled-back write. Revocation racing a commit cannot
undo committed data. Recover through a valid binding to the same definition and
scope. Reads linearize at transaction commit; already returned data cannot be
retracted by a later correction, revocation or deletion.

The synchronous SQLite implementation is for a standalone administrative
process. Future model-facing tools must put it in a worker; this step does not
claim the model dispatch deadline or retrieval budgets are implemented.

## Forget, disable and filesystem boundaries

Forget deletes **all** revisions, evidence and keyword entries for that record,
cancels indexing jobs, and leaves content-free tombstone/job/operation metadata.
Content-derived request hashes for prior save/correct operations are removed;
their operation IDs become retired and cannot recreate forgotten content.
The forget operation itself remains replayable. `secure_delete` is enabled;
`status` explicitly reports logical deletion, not hardware erasure or backup
cleanup. No vector cache exists yet.

Disable is persistent and scoped: ordinary reads/writes (including forget) fail
with `STORE_DISABLED`, while metadata-only `status`, `operation`, `disable` and
`enable` remain available. Enable explicitly restores access to existing notes.
It does not silently merge scopes or erase records.

Directories require mode 0700-equivalent privacy; database and journal files
must have no group/other access, be owned by the current user, and not be
symlinks or multiply linked files. The database is created 0600. Store identity
is rechecked across operations; unsafe/replaced paths fail closed. Local user
permissions govern administration; neither the CLI nor the binding registry is
an OS sandbox against the same user replacing files during a syscall race.
Never upload databases, journals, binding files or real inspection output.

## Migrations and rollback

`src/storage-schema.ts` owns immutable numbered migrations. SQLite application
ID, `user_version`, a migration checksum and definition ownership are checked.
A fresh schema is created transactionally with its migration ledger. Foreign
databases, checksum mismatches and newer schema versions fail explicitly;
there is no automatic downgrade or silent adoption of unrelated SQLite files.

Before an upgrade, stop **all** processes using the store and copy the complete
private store directory to an equally private backup outside the checkout.
Do not copy a live database independently of its journal. Future releases must
add forward migrations and test both fresh creation and every supported upgrade.
For this first storage release there is no earlier memory schema to import.

Rolling back application code is safe only if that version supports the stored
schema. Otherwise stop writers and restore a compatible backup, accepting the
loss of changes after that backup. Never manually lower `user_version`, mutate
published migration checksums or delete a hot journal to force startup.
Backups may still contain forgotten content; their retention is the operator's
responsibility.

## Synthetic verification

Run `npm run typecheck && npm test` in CI or an isolated development environment.
The complete suite includes real independent CLI processes, a committed save
with intentionally missing acknowledgement, restart/hot-journal recovery,
competing writers, explicit lock failures, source-error rollback, correction,
forget/retired retries, disable/enable, owner/scope separation, private paths and
future-schema refusal. Existing public-host identity gates run unchanged.
All fixtures are invented and removed after the run; no storage files are
uploaded as CI artifacts.
