import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { acceptance, distribution, LiveBudget } from "../src/evaluation.js";
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
    });
    try {
      const failure = worker.call(mode === "clone" ? { cannotClone() {} } : {}, Date.now() + (mode === "hang" ? 250 : 1_000));
      const recovered = worker.call({}, Date.now() + 2_000);
      await assert.rejects(failure, { code: mode === "exit" ? "WORKER_EXITED" : mode === "hang" ? "MEMORY_DEADLINE" : "WORKER_FAILED" });
      assert.equal(await recovered, "current");
    } finally { worker.close(); }
  }
});
