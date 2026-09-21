import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import test, { before, after } from "node:test";
import type { TestContext } from "node:test";
import { acceptance, corpus, distribution, releaseFaults } from "../src/evaluation.js";
import { loadBinding } from "../src/binding-registry.js";
import { MemoryStore } from "../src/memory-store.js";
import { MemoryWorker } from "../src/memory-worker-client.js";
import { ContextLedger } from "../src/context-ledger.js";
import { memoryLaunch } from "../src/memory-mcp.js";
import { SEARCH_TOOL, SAVE_TOOL } from "../src/memory-protocol.js";
import { isRecord } from "../src/identity.js";
import { activeIndex, writeAtomic } from "../src/semantic-files.js";
import { rebuildIndex } from "../src/semantic-index.js";
import type { SemanticConfig } from "../src/semantic-types.js";
import { createProductionFixture } from "./support/production-fixture.js";
import { prepareTestSemanticModel } from "./support/semantic-model.js";

const contract = await acceptance();
const required = releaseFaults;
const cases: string[] = [];
const report: Record<string, unknown> = { version: 1, contractHash: contract.hash, status: "unvalidated",
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  host: contract.config.host, corpusPerNamespace: contract.config.corpusPerNamespace, cases };
let root: string;
let config: SemanticConfig;
before(async () => {
  assert.ok(process.env.PINOCCHIO_TEST_PYTHON);
  root = await mkdtemp(join(tmpdir(), "pinocchio-release-model-"));
  config = await prepareTestSemanticModel(root);
});
after(async () => {
  report.status = required.every((name) => cases.includes(name)) ? "pass" : "fail";
  report.missing = required.filter((name) => !cases.includes(name));
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/reliability.json", JSON.stringify(report, null, 2) + "\n");
  if (root) await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  assert.equal(report.status, "pass");
});
async function fixture(t: TestContext, semantic = false) {
  const f = await createProductionFixture();
  const reference = await f.bind("alpha");
  const binding = await loadBinding(reference);
  const store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: "repository" });
  if (semantic) await writeAtomic(join(f.config, "pinocchio", "semantic.json"), config);
  let ledger = await ContextLedger.open(f.config);
  let worker = new MemoryWorker();
  const server = memoryLaunch(reference).serverName;
  t.after(async () => { worker.close(); ledger.close(); store.close(); await f.close(); });
  async function call(args: unknown, rootId = "root", recipient = "recipient", stamp = "2026-01-01T00:00:00.000Z", tool = SEARCH_TOOL) {
    ledger.start(rootId, recipient, stamp);
    const deadline = Date.now() + 1_000;
    const ticket = ledger.issue({ root: rootId, recipient, call: `call-${stamp}`, server,
      tool, directory: f.repository, arguments: args, deadline });
    const start = performance.now();
    const value = await worker.call({ action: "tool", reference, server, tool, arguments: args, ticket }, deadline);
    assert.ok(isRecord(value));
    return { value, duration: performance.now() - start };
  }
  return { ...f, reference, store, call, get ledger() { return ledger; },
    async restart() { worker.close(); ledger.close(); ledger = await ContextLedger.open(f.config); worker = new MemoryWorker(); },
  };
}
function child(path: string, args: string[]) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [path, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    process.stdout.on("data", (data: Buffer) => { out += data.toString(); });
    process.stderr.on("data", (data: Buffer) => { err += data.toString(); });
    process.on("error", reject); process.on("close", (code, signal) => resolve({ code, signal, out, err }));
  });
}
test("release fault gate: worker failures, identity denial and duplicate durable saves", async (t) => {
  const f = await fixture(t);
  const bad = new MemoryWorker(() => new Worker(new URL("./support/fault-worker.js", import.meta.url), { workerData: "error" }));
  try { await assert.rejects(bad.call({}), { code: "WORKER_FAILED" }); } finally { bad.close(); }
  cases.push("worker-failures");
  const raw = new MemoryWorker();
  try {
    await assert.rejects(raw.call({ action: "tool", reference: f.reference, server: memoryLaunch(f.reference).serverName,
      tool: SEARCH_TOOL, arguments: { query: "Lumen" }, ticket: {} }), { code: "MISSING_REQUEST_CONTEXT" });
  } finally { raw.close(); }
  cases.push("missing-identity");
  const args = { action: "remember", operationId: "duplicate", note: {
    content: "Synthetic durable duplicate marker DUPLICATE-17", kind: "fact",
    evidence: [{ kind: "user_statement", reference: { type: "text", value: "synthetic statement" } }],
  } };
  const first = await f.call(args, "root", "recipient", undefined, SAVE_TOOL);
  const repeated = await f.call(args, "root", "recipient", undefined, SAVE_TOOL);
  assert.equal(first.value.status, "committed");
  assert.equal(repeated.value.replayed, true);
  assert.equal(first.value.recordId, repeated.value.recordId);
  assert.equal((await f.store.indexMetadata()).length, 1);
  cases.push("duplicate-save");
});
test("release fault gate: committed lost acknowledgement and racing correction/deletion survive new processes", async (t) => {
  const f = await fixture(t);
  const referenceFile = join(f.config, "reference.json");
  await writeFile(referenceFile, JSON.stringify(f.reference), { mode: 0o600 });
  const script = fileURLToPath(new URL("./support/storage-child.js", import.meta.url));
  const lost = await child(script, [referenceFile, "lost-ack"]);
  assert.equal(lost.code, 0); assert.equal(lost.out, "");
  const receipt = await f.store.operationStatus("child-save");
  assert.equal(receipt.status, "committed");
  if (receipt.status !== "committed" || !receipt.recordId) assert.fail("COMMIT_NOT_RECOVERED");
  cases.push("lost-save-ack");
  const results = await Promise.all(["correct", "forget"].map((action) =>
    child(script, [referenceFile, action, receipt.recordId!, `race-${action}`])));
  assert.equal(results.filter((item) => item.code === 0).length, 1);
  assert.match(results.find((item) => item.code !== 0)?.err ?? "", /REVISION_CONFLICT|RECORD_FORGOTTEN|STORE_BUSY/);
  const record = (await f.store.inspect(receipt.recordId)).record;
  if (record.status !== "forgotten") await f.store.forget(record.id, record.revision, "final-forget");
  assert.equal((await f.store.indexMetadata()).length, 0);
  assert.equal((await f.store.inspect(receipt.recordId)).revisions.length, 0);
  cases.push("concurrent-correction-deletion");
});
test("release fault gate: killed generation publication recovers pending jobs without resurrecting records", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, true);
  const referenceFile = join(f.config, "reference.json");
  await writeFile(referenceFile, JSON.stringify(f.reference), { mode: 0o600 });
  for (const [index, phase] of ["generation-durable", "pointer-published"].entries()) {
    const saved = await f.store.remember({ content: `Synthetic publication marker BUILD-${index}`, kind: "fact",
      evidence: [{ kind: "manual_entry", reference: { type: "text", value: "synthetic build" } }] }, `build-${index}`);
    const crashed = await child(fileURLToPath(new URL("./support/index-crash.js", import.meta.url)), [referenceFile, phase]);
    assert.equal(crashed.signal, "SIGKILL", crashed.err);
    assert.ok((await f.store.status()).indexJobs.some((item) => item.status === "pending"));
    const generation = phase === "pointer-published" ? (await activeIndex(f.reference)).manifest.generation : undefined;
    await rebuildIndex(f.reference);
    if (generation) assert.equal((await activeIndex(f.reference)).manifest.generation, generation);
    assert.equal((await f.store.status()).indexJobs.some((item) => item.status === "pending"), false);
    assert.ok(saved.recordId); await f.store.forget(saved.recordId, 1, `forget-${index}`);
    await rebuildIndex(f.reference);
    assert.equal((await activeIndex(f.reference)).manifest.records.length, 0);
  }
  cases.push("interrupted-index-publication");
});
test("release gate: long sessions keep recalling within request limits across restarts and compaction", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  await f.store.remember({ content: "Project Lumen release marker LARCH-704.", kind: "decision",
    evidence: [{ kind: "user_statement", reference: { type: "text", value: "synthetic source" } }] }, "seed");
  let charged = 0, exhausted = 0, misses = 0, maxRequestCharge = 0, recalled = 0;
  for (let i = 0; i < contract.config.longSessionRequests; i++) {
    const stamp = new Date(Date.UTC(2026, 0, 1) + i * 1_000).toISOString();
    const recipient = `recipient-${i % 4}`;
    if (i && i % 16 === 0) { await f.restart(); f.ledger.invalidate("root"); }
    const result = await f.call({ query: i % 5 === 0 ? "nonexistent-identifier" : "Lumen" }, "root", recipient, stamp);
    exhausted += Number(result.value.status === "budget_exhausted");
    assert.equal(result.value.status, i % 5 === 0 ? "no_match" : "ok");
    maxRequestCharge = Math.max(maxRequestCharge, Number(result.value.chargedTokens ?? 0));
    recalled += Number(result.value.status === "ok");
    charged += Number(result.value.chargedTokens ?? 0);
    misses += Number(result.value.status === "no_match");
    assert.ok(maxRequestCharge <= 800);
    assert.equal(result.value.sessionUsed, charged);
    f.ledger.start("root", recipient, "2025-01-01T00:00:00.000Z");
  }
  assert.equal(exhausted, 0);
  assert.ok(charged > 6_000 && misses > 0);
  report.longSession = { requests: contract.config.longSessionRequests, charged, exhausted, misses,
    recalled, maxRequestCharge, restarts: 7 };
  cases.push("long-session-compaction");
  const db = new DatabaseSync(f.store.path);
  try {
    db.exec("BEGIN IMMEDIATE");
    await assert.rejects(f.call({ query: "Lumen" }, "lock-root"), { code: "STORE_BUSY" });
  } finally { db.exec("ROLLBACK"); db.close(); }
  cases.push("lock-failure");
  const first = await f.call({ query: "Lumen" }, "tool-chain");
  assert.equal(first.value.status, "ok");
  for (let i = 0; i < contract.config.longSessionRequests; i++) {
    const repeated = await f.call({ query: "Lumen" }, "tool-chain");
    assert.equal(repeated.value.status, "already_delivered");
    assert.equal(repeated.value.chargedTokens, 0);
    assert.equal(repeated.value.requestRemaining, first.value.requestRemaining);
    assert.equal(repeated.value.sessionUsed, first.value.sessionUsed);
  }
  report.toolChain = { callbacks: contract.config.longSessionRequests, additionalCharge: 0 };
});
test("release gate: warm hybrid backend p95 excludes model inference and includes worker/scope/accounting work", { timeout: 180_000 }, async (t) => {
  const f = await fixture(t, true);
  for (const [index, content] of corpus("foreground", contract.config.corpusPerNamespace).entries()) {
    await f.store.remember({ content, kind: "decision",
      evidence: [{ kind: "manual_entry", reference: { type: "text", value: "synthetic benchmark" } }] }, `seed-${index}`);
  }
  await rebuildIndex(f.reference);
  const cold = await f.call({ query: "Project Lumen approved release marker" }, "warm-root");
  report.coldBackendMs = cold.duration;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const result = await f.call({ query: "Project Lumen approved release marker" }, `warm-${i}`);
    if (isRecord(result.value.retrieval) && result.value.retrieval.mode === "hybrid") { ready = true; break; }
    await delay(250);
  }
  assert.ok(ready, "HYBRID_BACKEND_NOT_READY");
  const samples: number[] = [];
  for (let i = 0; i < contract.config.backendSamples; i++) {
    const result = await f.call({ query: `INV-${8 + i % 100}` }, `latency-${i}`);
    assert.equal(result.value.status, "ok");
    assert.ok(isRecord(result.value.retrieval) && result.value.retrieval.mode === "hybrid");
    samples.push(result.duration);
  }
  const stats = distribution(samples);
  report.backendMs = stats;
  assert.equal(stats.count, contract.config.backendSamples);
  assert.ok(stats.p95 !== null && stats.p95 < contract.config.thresholds.backendP95Ms, JSON.stringify(stats));
  cases.push("backend-latency");
});
