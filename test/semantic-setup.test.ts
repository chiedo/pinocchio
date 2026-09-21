import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { loadBinding } from "../src/binding-registry.js";
import { MemoryStore } from "../src/memory-store.js";
import { main as semantic } from "../src/semantic-cli.js";
import { retrievalMode, semanticConfig, setRetrievalMode, writeAtomic } from "../src/semantic-files.js";
import { SemanticRuntime } from "../src/semantic-runtime.js";
import { MODEL_REVISION } from "../src/semantic-types.js";
import { setup } from "../src/setup-cli.js";
import { prepareTestSemanticModel } from "./support/semantic-model.js";

test("default agent setup verifies hybrid readiness, shares its runtime, and upgrades indexes without changing identity", {
  timeout: 120_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-semantic-setup-"));
  const runtime = new SemanticRuntime(false);
  try {
    await prepareTestSemanticModel(root);
    const configuration = await readFile(join(root, "pinocchio", "semantic.json"), "utf8");
    const options = { configRoot: root, name: "hybrid-agent", global: true };
    const first = await setup(options);
    assert.ok("reference" in first && "retrieval" in first);
    assert.equal(first.retrieval.mode, "hybrid");
    assert.equal(first.retrieval.status, "ready");
    const binding = await loadBinding(first.reference);
    const store = await MemoryStore.open(first.reference, { namespace: binding.namespace, scope: "global" });
    let recordId: string | undefined;
    try {
      const saved = await store.remember({ content: "Restore accidentally deleted Git commits using git reflog.", kind: "fact",
        evidence: [{ kind: "manual_entry", reference: { type: "text", value: "synthetic setup probe" } }] }, "probe");
      assert.ok(saved.recordId);
      recordId = saved.recordId;
    } finally { store.close(); }
    const again = await setup(options);
    assert.ok("reference" in again && "retrieval" in again);
    assert.deepEqual(again.reference, first.reference);
    await runtime.warm(first.reference);
    const search = await runtime.candidates(first.reference, "How can I recover lost commits?");
    assert.equal(search.retrieval.mode, "hybrid");
    assert.ok(search.candidates?.some((candidate) => candidate.id === recordId));
    const second = await setup({ configRoot: root, name: "keyword-agent", global: true, retrieval: "keyword" });
    assert.ok("reference" in second && "retrieval" in second);
    const secondReference = second.reference;
    assert.equal(second.retrieval.mode, "keyword");
    assert.deepEqual((await runtime.candidates(second.reference, "anything")).retrieval,
      { mode: "keyword", reason: "KEYWORD_ONLY_CONFIGURED" });
    const upgraded = await semantic(["setup", "--config-root", root, "--all"]);
    assert.ok("agents" in upgraded);
    assert.equal(upgraded.status, "ready");
    assert.equal(await retrievalMode(second.reference), "keyword");
    assert.equal(await readFile(join(root, "pinocchio", "semantic.json"), "utf8"), configuration);
    await setup({ configRoot: root, name: "keyword-agent", global: true, retrieval: "hybrid" });
    assert.equal(await retrievalMode(second.reference), "hybrid");
    await setup({ configRoot: root, name: "keyword-agent", remove: true });
    const unenrolled = await semantic(["setup", "--config-root", root, "--all"]);
    assert.ok("agents" in unenrolled);
    assert.equal(unenrolled.agents.find((agent) => agent.bindingId === secondReference.bindingId)?.status, "skipped");
  } finally { await runtime.close(); await rm(root, { recursive: true }); }
});

test("default setup bootstraps a managed Python environment without an explicit runtime", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-default-bootstrap-"));
  const source = await mkdtemp(join(tmpdir(), "pinocchio-bootstrap-assets-"));
  try {
    const shared = await prepareTestSemanticModel(source);
    const models = join(root, "pinocchio", "embeddings");
    await mkdir(models, { recursive: true, mode: 0o700 });
    await cp(shared.modelDirectory, join(models, MODEL_REVISION), { recursive: true });
    const result = await setup({ configRoot: root, name: "default-agent", global: true });
    assert.ok("retrieval" in result);
    assert.deepEqual({ mode: result.retrieval.mode, status: result.retrieval.status }, { mode: "hybrid", status: "ready" });
    const config = await semanticConfig(root);
    assert.equal(config.python, join(root, "pinocchio", "semantic-runtime", "venv", "bin", "python"));
    const repeated = await setup({ configRoot: root, name: "second-agent", global: true });
    assert.ok("retrieval" in repeated && repeated.retrieval.mode === "hybrid");
    assert.deepEqual(await semanticConfig(root), config);
  } finally { await rm(root, { recursive: true }); await rm(source, { recursive: true }); }
});

test("failed semantic setup is not ready and can be recovered without replacing the enrolled profile or binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-semantic-failed-"));
  try {
    const options = { configRoot: root, name: "recoverable", global: true };
    await assert.rejects(setup({ ...options, python: join(root, "missing-python") }),
      { code: "SEMANTIC_EXPLICIT_PYTHON_DEPENDENCIES_REQUIRED" });
    const receipt = join(root, "pinocchio", "setup", "recoverable.json");
    const original = await readFile(receipt, "utf8");
    const profile = join(root, "agents", "recoverable.agent.md");
    await writeFile(profile, (await readFile(profile, "utf8")) + "\nKeep authored instructions.\n");
    const recovered = await setup({ ...options, retrieval: "keyword" });
    assert.ok("reference" in recovered && "retrieval" in recovered);
    assert.equal(recovered.retrieval.mode, "keyword");
    assert.equal(await readFile(receipt, "utf8"), original);
    assert.match(await readFile(profile, "utf8"), /Keep authored instructions/);
    await assert.rejects(stat(join(root, "pinocchio", "semantic.json")), { code: "ENOENT" });
    const runtime = new SemanticRuntime(false);
    try {
      await runtime.warm(recovered.reference);
      assert.equal((await runtime.candidates(recovered.reference, "anything")).retrieval.reason, "KEYWORD_ONLY_CONFIGURED");
    } finally { await runtime.close(); }
    const failed = await semantic(["setup", "--config-root", root, "--all", "--hybrid", "--python", join(root, "missing-python")]);
    assert.ok("agents" in failed);
    assert.equal(failed.status, "degraded");
    assert.equal(failed.agents[0]?.status, "failed");
    await assert.rejects(promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../src/install-cli.js", import.meta.url)),
      "semantic", "setup", "--config-root", root, "--all", "--hybrid", "--python", join(root, "missing-python"),
    ]), { code: 1 });
    await setup({ configRoot: root, name: "unaffected", global: true, retrieval: "keyword" });
    await setRetrievalMode(recovered.reference, "hybrid");
    await writeAtomic(join(root, "pinocchio", "semantic.json"), { version: 0 });
    const partial = await semantic(["setup", "--config-root", root, "--all"]);
    assert.ok("agents" in partial);
    assert.equal(partial.status, "degraded");
    assert.equal(partial.agents.filter((agent) => agent.status === "ready").length, 1);
    assert.equal(partial.agents.filter((agent) => agent.status === "failed").length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(root, "pinocchio", "semantic.json"), "utf8")), { version: 0 });
    await assert.rejects(setup({ ...options, retrieval: "keyword", python: "/invalid" }), { code: "INVALID_ARGUMENTS" });
    await assert.rejects(semantic(["setup", "--config-root", root, "--all", "--keyword-only", "--hybrid"]),
      { code: "INVALID_ARGUMENTS" });
  } finally { await rm(root, { recursive: true }); }
});

test("semantic setup lock prevents concurrent runtime mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-semantic-lock-"));
  try {
    const options = { configRoot: root, name: "locked", global: true, retrieval: "keyword" as const };
    await setup(options);
    await writeFile(join(root, "pinocchio", "semantic-setup.lock"), "", { mode: 0o600 });
    await assert.rejects(setup(options), { code: "SEMANTIC_SETUP_BUSY" });
  } finally { await rm(root, { recursive: true }); }
});
