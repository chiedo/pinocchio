import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { TestContext } from "node:test";
import { loadBinding } from "../src/binding-registry.js";
import { MemoryStore } from "../src/memory-store.js";
import { main as semanticMain } from "../src/semantic-cli.js";
import { activeIndex, indexDirectory, semanticConfig, sha, writeAtomic } from "../src/semantic-files.js";
import { rebuildIndex, indexStatus } from "../src/semantic-index.js";
import { SemanticRuntime } from "../src/semantic-runtime.js";
import { SemanticProcess } from "../src/semantic-process.js";
import { fuseRanks } from "../src/hybrid-ranking.js";
import { MODEL_ID } from "../src/semantic-types.js";
import type { SemanticConfig } from "../src/semantic-types.js";
import { createProductionFixture } from "./support/production-fixture.js";
import { ContextLedger } from "../src/context-ledger.js";
import { MemoryWorker } from "../src/memory-worker-client.js";
import { memoryLaunch } from "../src/memory-mcp.js";
import { SEARCH_TOOL } from "../src/memory-protocol.js";
import { isRecord } from "../src/identity.js";
import { setTimeout as delay } from "node:timers/promises";

let root: string;
let configuration: SemanticConfig;
const report: Record<string, unknown> = { gate: "local-semantic-retrieval", model: MODEL_ID, paidCalls: 0 };
before(async () => {
  assert.ok(process.env.PINOCCHIO_TEST_PYTHON, "PINOCCHIO_TEST_PYTHON_REQUIRED; install semantic/requirements.txt in an isolated environment");
  root = await mkdtemp(join(tmpdir(), "pinocchio-semantic-model-"));
  await semanticMain(["prepare", "--config-root", root, "--python", process.env.PINOCCHIO_TEST_PYTHON]);
  configuration = await semanticConfig(root);
});
after(async () => {
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/semantic.json", JSON.stringify(report, null, 2) + "\n");
  if (root) await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
});
async function fixture(t: TestContext) {
  const f = await createProductionFixture();
  const reference = await f.bind("alpha");
  const binding = await loadBinding(reference);
  const store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: binding.scope.kind });
  await writeAtomic(join(f.config, "pinocchio", "semantic.json"), configuration);
  const runtime = new SemanticRuntime(false);
  t.after(async () => { await runtime.close(); store.close(); await f.close(); });
  async function save(content: string, operation: string) {
    return store.remember({ content, kind: "procedure", evidence: [
      { kind: "manual_entry", reference: { type: "text", value: "invented semantic fixture" } },
    ] }, operation);
  }
  async function search(query: string) {
    const result = await runtime.candidates(reference, query, Date.now() + 1_000);
    const matches = await store.searchSnapshot(query, { limit: 3 }, (value) => value, result.candidates ?? []);
    return { ...matches, retrieval: result.retrieval };
  }
  return { ...f, reference, store, runtime, save, search };
}

test("real local embeddings improve paraphrase recall while retaining exact identifiers and rejecting irrelevant queries", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const documents = [
    "Restore accidentally deleted Git commits using git reflog.",
    "Speed up repeated application requests by caching expensive database queries.",
    "Rotate compromised API credentials immediately and invalidate the old secret.",
    "DEPLOY-42 requires a successful staging smoke check before production deployment.",
    "Use exponential backoff to retry transient network failures.",
    "Split large pull requests into small independently reviewable changes.",
  ];
  const ids: string[] = [];
  for (const [index, content] of documents.entries()) {
    const saved = await f.save(content, `doc-${index}`); assert.ok(saved.recordId); ids.push(saved.recordId);
  }
  await rebuildIndex(f.reference);
  await f.runtime.warm(f.reference);
  const corpus = [
    { query: "How can I recover lost commits?", expected: ids[0] },
    { query: "How can we make slow database requests faster?", expected: ids[1] },
    { query: "What should we do when an API key is leaked?", expected: ids[2] },
    { query: "How should temporary connection errors be retried?", expected: ids[4] },
  ];
  let keywordHits = 0, hybridHits = 0;
  for (const item of corpus) {
    if ((await f.store.search(item.query, { limit: 3 })).items.some((row) => row.id === item.expected)) keywordHits++;
    const result = await f.search(item.query);
    assert.equal(result.retrieval.mode, "hybrid", JSON.stringify(result.retrieval));
    if (result.items.some((row) => row.id === item.expected)) hybridHits++;
  }
  report.quality = { queries: corpus.length, keywordHits, hybridHits, minimumHybridHits: 3 };
  assert.ok(hybridHits >= 3 && hybridHits > keywordHits, JSON.stringify(report.quality));
  assert.equal((await f.search("DEPLOY-42")).items[0]?.id, ids[3]);
  assert.equal((await f.search("What is the height of Mount Everest?")).status, "no_match");
  assert.equal((await f.store.status()).indexJobs.find((row) => row.status === "pending"), undefined);
});

test("old vectors never score corrections or resurrect forgotten content; rebuild completes cleanup", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const saved = await f.save("Recover deleted Git commits with git reflog.", "original");
  assert.ok(saved.recordId);
  await rebuildIndex(f.reference);
  await f.runtime.warm(f.reference);
  assert.equal((await f.search("Recover lost commits")).items[0]?.id, saved.recordId);
  await f.store.correct(saved.recordId, 1, {
    content: "The synthetic handbook now documents brewing green tea.", kind: "procedure",
    evidence: [{ kind: "manual_entry", reference: { type: "text", value: "invented correction" } }],
  }, "correct");
  assert.equal((await f.search("Recover lost commits")).status, "no_match");
  assert.equal((await f.search("green tea")).items[0]?.revision, 2);
  assert.equal((await indexStatus(f.reference)).pendingPhysicalCleanup, true);
  await rebuildIndex(f.reference);
  assert.equal((await indexStatus(f.reference)).pendingPhysicalCleanup, false);
  await f.store.forget(saved.recordId, 2, "forget");
  assert.equal((await f.search("green tea")).status, "no_match");
  assert.equal((await indexStatus(f.reference)).pendingPhysicalCleanup, true);
  await rebuildIndex(f.reference);
  assert.equal((await indexStatus(f.reference)).pendingPhysicalCleanup, false);
  assert.equal((await activeIndex(f.reference)).manifest.records.length, 0);
});

test("missing and corrupted indexes visibly degrade and rebuild without adopting foreign scopes", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  await f.save("synthetic identifier EXACT-7", "save");
  await f.runtime.warm(f.reference);
  const missing = await f.search("EXACT-7");
  assert.equal(missing.retrieval.mode, "keyword");
  assert.ok(missing.retrieval.reason);
  assert.equal(missing.items.length, 1);
  await rebuildIndex(f.reference);
  const active = await activeIndex(f.reference);
  await writeFile(active.path, "broken synthetic index", { mode: 0o600 });
  const broken = await f.search("EXACT-7");
  assert.equal(broken.retrieval.mode, "keyword");
  assert.equal(broken.items.length, 1);
  await rebuildIndex(f.reference);
  assert.equal((await f.search("EXACT-7")).retrieval.mode, "hybrid");
  const otherRef = await f.bind("alpha", { kind: "repository", root: f.otherRepository });
  const otherBinding = await loadBinding(otherRef);
  const otherStore = await MemoryStore.open(otherRef, { namespace: otherBinding.namespace, scope: otherBinding.scope.kind });
  try {
    const candidates = await f.runtime.candidates(f.reference, "EXACT-7");
    assert.equal((await otherStore.searchSnapshot("EXACT-7", {}, (value) => value, candidates.candidates ?? [])).items.length, 0);
  } finally { otherStore.close(); }
});

test("cross-process builder locks and stale snapshots fail explicitly; abandoned generations are recoverable", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  await f.save("synthetic build coordination", "save");
  const location = await indexDirectory(f.reference, true);
  const first = new SemanticProcess(configuration), second = new SemanticProcess(configuration);
  try {
    await Promise.all([first.ready(), second.ready()]);
    await first.call({ action: "acquire", path: join(location.directory, "builder.lock") }, 1_000);
    await assert.rejects(second.call({ action: "acquire", path: join(location.directory, "builder.lock") }, 1_000),
      { code: "BUILDER_BUSY" });
  } finally { first.close(); second.close(); }
  const snapshot = await f.store.indexSnapshot();
  await f.save("synthetic concurrent insert", "concurrent");
  let published = false;
  await assert.rejects(f.store.publishIndex(snapshot, async () => { published = true; }), { code: "STALE_INDEX_BUILD" });
  assert.equal(published, false);
  const orphan = join(location.directory, ".staging-00000000-0000-4000-8000-000000000000");
  await mkdir(orphan, { mode: 0o700 });
  await writeFile(join(orphan, "index.faiss"), "incomplete", { mode: 0o600 });
  await rebuildIndex(f.reference);
  assert.equal((await indexStatus(f.reference)).obsoleteGenerations, 0);
  const original = await activeIndex(f.reference);
  const pointerBytes = await readFile(join(location.directory, "active.json"));
  assert.ok(pointerBytes.includes(original.manifest.generation));
});

test("rank fusion ignores stale revisions and uses source/confirmation time, never record update time", () => {
  const now = Date.parse("2026-09-10T00:00:00Z");
  const old = { id: "old", revision: 2, content: "same synthetic query", source_at: "2020-01-01T00:00:00Z", confirmed_at: null };
  const fresh = { id: "fresh", revision: 1, content: "same synthetic query", source_at: "2026-09-09T00:00:00Z", confirmed_at: null };
  assert.equal(fuseRanks("synthetic", [old, fresh], [], [], now)[0]?.id, "fresh");
  assert.deepEqual(fuseRanks("unmatched", [], [old], [{ id: "old", revision: 1, score: 1 }], now), []);
  assert.deepEqual(fuseRanks("unmatched", [], [old], [{ id: "old", revision: 2, score: 0.1 }], now), []);
  report.recencyAndRevisionFiltering = true;
});

test("published model metadata corruption is rejected before deserializing FAISS", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  await f.save("synthetic model compatibility", "save");
  await rebuildIndex(f.reference);
  const active = await activeIndex(f.reference);
  const path = join(active.directory, active.manifest.generation, "manifest.json");
  await writeAtomic(path, { ...active.manifest, model: "incompatible-model" });
  await writeAtomic(join(active.directory, "active.json"), {
    generation: active.manifest.generation, manifestHash: sha(await readFile(path)),
  });
  await f.runtime.warm(f.reference);
  assert.equal((await f.search("synthetic")).retrieval.mode, "keyword");
  await rebuildIndex(f.reference);
  assert.equal((await f.search("synthetic")).retrieval.mode, "hybrid");
});

test("real hybrid retrieval through the model worker preserves recipient budgets and visible warmup fallback", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  await f.save("Restore accidentally deleted Git commits using git reflog.", "save");
  await rebuildIndex(f.reference);
  const ledger = await ContextLedger.open(f.config);
  const worker = new MemoryWorker();
  const server = memoryLaunch(f.reference).serverName;
  ledger.start("semantic-root", "semantic-recipient", "2026-01-01T00:00:00.000Z");
  const args = { query: "How can I recover lost commits?" };
  async function call() {
    const deadline = Date.now() + 1_000;
    const ticket = ledger.issue({ root: "semantic-root", recipient: "semantic-recipient", call: "semantic-call",
      server, tool: SEARCH_TOOL, directory: f.repository, arguments: args, deadline });
    const start = performance.now();
    const result = await worker.call({ action: "tool", reference: f.reference, server, tool: SEARCH_TOOL, arguments: args, ticket }, deadline);
    assert.ok(performance.now() - start < 1_000);
    assert.ok(isRecord(result));
    return result;
  }
  try {
    let result = await call();
    assert.ok(isRecord(result.retrieval));
    assert.equal(result.retrieval.mode, "keyword");
    assert.ok(result.retrieval.reason);
    for (let attempt = 0; attempt < 40 && result.status !== "ok"; attempt++) {
      await delay(250); result = await call();
    }
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.ok(isRecord(result.retrieval));
    assert.equal(result.retrieval.mode, "hybrid");
    assert.ok(Array.isArray(result.snippets) && result.snippets.length <= 3);
    assert.ok(Buffer.byteLength(JSON.stringify(result.snippets)) <= 800);
    assert.equal(result.chargedTokens, Buffer.byteLength(JSON.stringify(result.snippets)));
    const repeat = await call();
    assert.equal(repeat.status, "already_delivered");
    assert.equal(repeat.sessionRemaining, result.sessionRemaining);
    report.workerBudgetsAndWarmup = true;
  } finally { worker.close(); ledger.close(); }
});
