# Local semantic retrieval

Semantic retrieval is optional. SQLite remains authoritative; an unavailable,
warming, corrupt or incompatible semantic index explicitly falls back to keyword
search. No model-facing tool name, namespace authority, snippet limit or context
budget changes.

## Pinned model and runtime

| Item | Configuration |
|---|---|
| Model | `Xenova/all-MiniLM-L6-v2` |
| Immutable revision | `751bff37182d3f1213fa05d7196b954e230abad9` |
| Model license | Apache-2.0 |
| Representation | Quantized ONNX, attention-mask mean pooling, L2 normalization |
| Dimensions / input cap | 384 / 256 WordPiece tokens including special tokens |
| Download | 23,684,031 bytes total: model and tokenizer |
| Index | FAISS `IndexFlatIP` over normalized vectors (cosine similarity) |
| Development baseline | Linux x64, Python 3.12+, Node 22.18.0 |
| Runtime pins | `semantic/requirements.txt`: FAISS 1.15.0, NumPy 2.5.3, ONNX Runtime 1.30.0, tokenizers 0.23.2 |

[Pinned model](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9)
and [upstream model card/license](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2).
Artifact byte sizes and SHA-256 digests are committed in `semantic/model.json`.
FAISS's [cosine-metric documentation](https://github.com/facebookresearch/faiss/wiki/MetricType-and-distances)
describes normalized inner-product search.

Long notes are truncated for embedding; their **complete** content remains
keyword-searchable in SQLite. Prefer short, atomic notes. This release does not
claim long-document chunking or model-specific tokenizer precision for the
separate memory-delivery budget.

Allow approximately 1 GiB of RAM for concurrent query/build processes as a
planning allowance, not a measured upper bound. CPU inference uses one thread
per process. Runtime installation requires additional disk space for Python
wheels; each vector requires 1,536 bytes before metadata. Each scope is bounded
to 5,000 active/tentative records and 4 MiB of raw content per rebuild, with an
8 MiB IPC-frame cap. Exceeding a bound is explicit; no partial index is published.

## Explicit setup

Build the checkout and prepare an isolated Python environment. These are
development commands, not a production installer:

```bash
npm ci
npm run build
python3 -m venv .venv
.venv/bin/pip install -r semantic/requirements.txt
```

Use Python 3.12 or newer when creating the environment. Then choose the same
private config root used by your bindings:

```bash
node dist/src/semantic-cli.js prepare \
  --config-root "$CONFIG_ROOT" --python "$PWD/.venv/bin/python"
```

**Prepare downloads the pinned public model files.** It checks exact sizes and
SHA-256 hashes, opens the local runtime successfully, then atomically writes a
private configuration. No notes are sent during preparation. Moving this
checkout or virtual environment requires preparing the runtime path again.
Keep the `semantic/` assets with the source runtime; copying `dist/` alone is
not a portable installation.

Models live under `<config-root>/pinocchio/embeddings/<revision>/`; the explicit
runtime configuration is `<config-root>/pinocchio/semantic.json`. All model and
index directories are private. Interpreter version mismatches or missing wheels
produce visible unavailable/degraded results rather than hidden downloads.

After preparation, model-facing `agent_memory_search` uses the existing worker
interface. The first call may report `SEMANTIC_WARMING` while a local query
process starts. A separate, lazy builder checks for changes at most once per
30 seconds of active search use. It resumes pending work; there is no
always-running daemon and no forced model follow-up.

An explicit rebuild avoids waiting for that lazy maintenance:

```bash
node dist/src/semantic-cli.js rebuild --config-root "$CONFIG_ROOT" \
  --binding "$BINDING_ID" --fingerprint "$FINGERPRINT"
node dist/src/semantic-cli.js status --config-root "$CONFIG_ROOT" \
  --binding "$BINDING_ID" --fingerprint "$FINGERPRINT"
```

The existing administrative search also supports hybrid retrieval:

```bash
node dist/src/memory-cli.js search --hybrid --query "recover lost commits" \
  --config-root "$CONFIG_ROOT" --binding "$BINDING_ID" --fingerprint "$FINGERPRINT" \
  --namespace "$NAMESPACE" --scope repository
```

Omit `--hybrid` to retain the administrative keyword-only baseline. Administrative
hybrid search may wait for local model startup; model-facing dispatch never waits
for cold startup. Its one-second total deadline, three snippets, 800-unit
recipient limit and 6,000-unit root-session allowance remain enforced.

## Ranking and freshness

Candidates below cosine similarity **0.45** are discarded. Valid semantic,
keyword and normalized literal matches are combined with reciprocal-rank fusion
(`k=60`; semantic/keyword weight 1, literal weight 2). Raw cosine and keyword
scores are not added together.

The fused rank receives at most a 10% recency boost, decaying with a 30-day
half-life. Only confirmation time, or source time if unconfirmed, supplies
recency. Missing source dates are neutral. Retrieval, recording time,
correction timestamps and index rebuilds never make an old source newly recent.

Immediately before delivery, SQLite rechecks the bound scope, active/tentative
status and **exact indexed revision**, inside the existing read/accounting
transaction. Corrected notes can match fresh keywords immediately, but old
vectors never score their replacement text. Forgotten, superseded or foreign
records cannot return from a stale generation.

Responses include `retrieval.mode` (`hybrid` or `keyword`) and a fixed degradation
`reason` when applicable. Missing/corrupt index failures are not silently
presented as healthy semantic no-match results. A generation and maintenance
status are included when available. Broken runtime processes are retried with
backoff; semantic query timeouts reserve time for bounded keyword fallback.

## Durable generations and recovery

Each namespace contains a separate scoped index directory:

```text
agent-memories/<namespace>/semantic/<scope-hash>/
  builder.lock
  active.json
  <generation-uuid>/
    manifest.json
    index.faiss
```

An OS advisory lock serializes builders across processes and releases when a
builder dies. Builds snapshot current SQLite records, embed outside the database
transaction, and write an immutable staged generation. Every file and directory
is synchronized before publication.

Publication holds a SQLite writer transaction, verifies the entire live
ID/revision set still matches the snapshot, atomically replaces and syncs the
active pointer, and completes matching pending index jobs. A concurrent edit
returns `STALE_INDEX_BUILD`; source records remain untouched and jobs retry.

The filesystem pointer and SQLite are **not a distributed transaction**. A crash
after pointer publication but before job commit can leave a valid generation
with pending jobs. Rebuild recognizes the matching source fingerprint and
finishes those jobs without re-embedding. A crash before publication leaves an
unused staged/generation directory; readers never scan such directories.
Checksums, model identity, dimensions, scope and format are validated before
native FAISS deserialization. Source stores are never replaced by index data.

Build computation has a 120-second parent deadline and a 125-second process
alarm. Failures remain pending and retries rebuild from SQLite. A corrupt
derived generation can be replaced explicitly; unsafe filesystem permissions,
links and invalid source bindings are not silently repaired.

## Forget and cleanup

Forget removes SQLite content immediately and cancels its jobs. Even while the
active index still contains the old vector, live revision/status checks prevent
its return. The next successful rebuild publishes only current records and
deletes obsolete disk generations. Superseded-record delete jobs are completed
when excluded from the new generation.

`semantic status` reports stale vectors, obsolete/staged generations, pending
jobs, scoped disable state and `pendingPhysicalCleanup`. That flag describes
**disk generations**; independently running processes refresh cached vectors
on their next query or exit. The administrative process does not claim to
inspect or erase every other process's memory.

To remove orphaned/obsolete disk generations after a valid publication:

```bash
node dist/src/semantic-cli.js cleanup --config-root "$CONFIG_ROOT" \
  --binding "$BINDING_ID" --fingerprint "$FINGERPRINT"
```

Cleanup does not delete source records, the active generation, public model
files or backups. A published index with failed cleanup is explicitly reported
as indexed with cleanup pending. Hardware secure erasure is not promised.

Embedding and query processes are local, use offline/telemetry-disabled
settings, and reject socket connections through a Python audit guard. They
never upload notes for embedding. These controls are not an OS sandbox against
another program running with the same user's permissions. Treat vector files
and manifests as private data; never upload them in diagnostics.

## Synthetic gate

In CI or an isolated development environment, run the complete suite:

```bash
PINOCCHIO_TEST_PYTHON="$PWD/.venv/bin/python" npm test
```

The gate downloads only pinned public model files and uses invented notes.
Before collecting results it fixes six source notes, four paraphrase queries,
a minimum of three top-three semantic hits, improvement over keyword-only
retrieval, an exact-identifier check and an irrelevant-query rejection.
Additional cases cover real model-worker budgets, revision filtering, deletion,
scope isolation, process locks, stale publication, abandoned generations,
corruption and model mismatch. No paid model calls or real transcripts are used.
Only the aggregate `test-results/semantic.json` is published.

This small corpus is evidence of semantic retrieval benefit, not the broader
live-model behavior, throughput or p95 latency certification reserved for #6.
