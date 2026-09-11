import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { acceptance, distribution, LiveBudget, releaseFaults, releaseVerdict, roles } from "../src/evaluation.js";
import { MemoryWorker } from "../src/memory-worker-client.js";

test("release statistics use nearest-rank p95, preserve empty samples and reject invalid latency", async () => {
  const { config, hash } = await acceptance();
  assert.equal(hash.length, 64);
  assert.equal(config.backendSamples, 100);
  assert.deepEqual(distribution([]), { count: 0, p50: null, p95: null });
  assert.deepEqual(distribution(Array.from({ length: 100 }, (_, i) => i + 1)), { count: 100, p50: 50, p95: 95 });
  assert.throws(() => distribution([NaN]), /INVALID_LATENCY_SAMPLE/);
});
test("live budgets count duplicate telemetry once and fail closed on absent cost, caps and invalid usage", async () => {
  const { config } = await acceptance();
  const budget = new LiveBudget(config.limits);
  budget.admit();
  budget.record("one", { inputTokens: 50, outputTokens: 4, nanoAiu: 100 });
  budget.record("one", { inputTokens: 50, outputTokens: 4, nanoAiu: 100 });
  assert.equal(budget.calls, 1);
  assert.equal(budget.nanoAiu, 100);
  budget.record("missing", { inputTokens: NaN });
  assert.throws(() => budget.admit(), /LIVE_BUDGET_OR_USAGE_UNAVAILABLE/);
  const capped = new LiveBudget({ ...config.limits, nanoAiu: 1 });
  capped.record("capped", { inputTokens: 0, outputTokens: 0, nanoAiu: 1 });
  assert.throws(() => capped.admit(), /LIVE_BUDGET_OR_USAGE_UNAVAILABLE/);
});
test("worker launch, crash, clone and late replies cannot strand the queue or acknowledge stale work", async () => {
  for (const mode of ["launch", "exit", "error", "clone", "hang"]) {
    let launches = 0;
    const worker = new MemoryWorker(() => {
      launches++;
      if (mode === "launch" && launches === 1) throw new Error("INJECTED_LAUNCH_FAILURE");
      return new Worker(new URL("./support/fault-worker.js", import.meta.url), {
        workerData: launches === 1 ? mode : "reply",
      });
      test("release decisions recompute thresholds and reject missing, stale, incomplete or forged pass flags", async () => {
        const contract = await acceptance(), { config } = contract, commit = "synthetic-commit";
        const reliability = { status: "pass", contractHash: contract.hash, commit, host: config.host,
          corpusPerNamespace: 128, cases: releaseFaults, backendMs: { count: 100, p50: 20, p95: 40 },
          longSession: { requests: 128, charged: 5_999, exhausted: 90, misses: 5 } };
        const live = { status: "pass", contractHash: contract.hash, commit, model: config.model, effort: config.effort,
          roles: roles.map((role) => ({ role, recall: 4, baseline: 0, searched: 4, retrieved: 4, saved: 4, unknown: 1,
            leaks: 0, recallSamples: 4, baselineSamples: 4, saveSamples: 4, failures: 0, followup: 1, attempted: 14, completed: 14 })),
          usage: { calls: 50, inputTokens: 100, outputTokens: 100, nanoAiu: 100, missingUsage: 0, exhausted: false },
          failures: [], omissions: roles.map((role) => ({ role, trials: 0 })),
          roleLatency: roles.map((role) => ({ role, trialMs: { count: 14, p50: 1, p95: 2 },
            modelMs: { count: 20, p50: 1, p95: 2 }, toolMs: { count: 10, p50: 1, p95: 2 } })),
        };
        const workflow = { passed: true, cases: ["native-compaction-preserves-accounting"] };
        const verdict = (s: unknown = reliability, l: unknown = live, w: unknown = workflow) =>
          releaseVerdict(contract, commit, s, l, w).status;
        assert.equal(verdict(), "pass");
        assert.equal(releaseVerdict(contract, commit, reliability, undefined, workflow).status, "unvalidated");
        assert.equal(verdict(reliability, { ...live, commit: "stale" }), "fail");
        assert.equal(verdict({ ...reliability, backendMs: { count: 100, p50: 20, p95: 250 } }), "fail");
        assert.equal(verdict({ ...reliability, cases: [] }), "fail");
        assert.equal(verdict(reliability, { ...live, roles: live.roles.map((r) => ({ ...r, searched: 0 })) }), "fail");
        assert.equal(verdict(reliability, { ...live, roles: [live.roles[0], live.roles[0]] }), "fail");
        assert.equal(verdict(reliability, { ...live, omissions: [{ role: "foreground", trials: 1 }] }), "fail");
        assert.equal(verdict(reliability, { ...live, usage: { ...live.usage, missingUsage: 1 } }), "fail");
        assert.equal(verdict(reliability, live, { passed: true, cases: [] }), "fail");
      });
    });
    try {
      const failure = worker.call(mode === "clone" ? { cannotClone() {} } : {}, Date.now() + (mode === "hang" ? 250 : 1_000));
      const recovered = worker.call({}, Date.now() + 2_000);
      await assert.rejects(failure, { code: mode === "exit" ? "WORKER_EXITED" : mode === "hang" ? "MEMORY_DEADLINE" : "WORKER_FAILED" });
      assert.equal(await recovered, "current");
    } finally { worker.close(); }
  }
});
