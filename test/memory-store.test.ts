import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import { loadBinding, revokeBinding } from "../src/binding-registry.js";
import type { BindingReference } from "../src/binding-registry.js";
import { MemoryStore } from "../src/memory-store.js";
import { acknowledge } from "../src/memory-types.js";
import type { NoteInput } from "../src/memory-types.js";
import { createProductionFixture } from "./support/production-fixture.js";

const note = (content = "synthetic cobalt identifier ABC-123"): NoteInput => ({
  content, kind: "fact",
  evidence: [{ kind: "manual_entry", reference: { type: "text", value: "invented fixture" } }],
});
async function fixture(t: TestContext) {
  const f = await createProductionFixture();
  const stores: MemoryStore[] = [];
  t.after(async () => { for (const store of stores) store.close(); await f.close(); });
  const ref = await f.bind("alpha");
  async function open(reference = ref) {
    const binding = await loadBinding(reference);
    const store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: binding.scope.kind });
    stores.push(store);
    return store;
  }
  return { ...f, ref, open };
}
function child(script: string, args: string[], stdin?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    process.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    process.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    process.on("error", reject);
    process.on("close", (code) => resolve({ code, stdout, stderr }));
    process.stdin.end(stdin);
  });
}
async function cliArgs(ref: BindingReference) {
  const binding = await loadBinding(ref);
  return ["--config-root", ref.configRoot, "--binding", ref.bindingId, "--fingerprint", ref.fingerprint,
    "--namespace", binding.namespace, "--scope", binding.scope.kind];
}
const cli = fileURLToPath(new URL("../src/memory-cli.js", import.meta.url));
const childScript = fileURLToPath(new URL("./support/storage-child.js", import.meta.url));

test("storage commits records, provenance, keyword entries and jobs; retries are durable", async (t) => {
  const f = await fixture(t);
  let store = await f.open();
  const saved = await store.remember(note(), "save-1");
  assert.equal(saved.status, "committed");
  assert.equal(saved.revision, 1);
  assert.ok(saved.recordId);
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    for (const table of ["records", "revisions", "keyword_entries", "index_jobs", "operations"]) {
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, 1);
    }
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1);
  } finally { db.close(); }
  store.close();
  store = await f.open();
  assert.equal((await store.remember(note(), "save-1")).replayed, true);
  await assert.rejects(store.remember(note("different"), "save-1"), { code: "OPERATION_CONFLICT" });
  assert.equal((await store.search("ABC-123")).items[0]?.content, note().content);
  assert.equal((await store.search("identifier cobalt")).items.length, 1);
  assert.equal((await store.search("' OR 1=1 --")).status, "no_match");
  assert.equal((await store.inspect(saved.recordId)).revisions.length, 1);
  assert.equal((await store.operationStatus("missing")).status, "not_found");
});

test("correction removes stale terms and forget removes all content without retry resurrection", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  const saved = await store.remember(note(), "original");
  assert.ok(saved.recordId);
  const corrected = await store.correct(saved.recordId, 1, note("synthetic amber replacement"), "correction");
  assert.equal(corrected.revision, 2);
  assert.equal((await store.search("cobalt")).status, "no_match");
  assert.equal((await store.search("amber")).items.length, 1);
  assert.equal((await store.inspect(saved.recordId)).revisions.length, 2);
  await assert.rejects(store.correct(saved.recordId, 1, note(), "stale"), { code: "REVISION_CONFLICT" });
  const forgotten = await store.forget(saved.recordId, 2, "forget");
  assert.equal(forgotten.revision, 3);
  assert.equal((await store.forget(saved.recordId, 2, "forget")).replayed, true);
  assert.equal((await store.inspect(saved.recordId)).revisions.length, 0);
  assert.equal((await store.search("amber")).status, "no_match");
  await assert.rejects(store.remember(note(), "original"), { code: "OPERATION_RETIRED" });
  await assert.rejects(store.correct(saved.recordId, 3, note(), "resurrect"), { code: "RECORD_FORGOTTEN" });
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    for (const table of ["revisions", "keyword_entries", "keyword_terms"]) {
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, 0);
    }
    assert.equal(db.prepare("SELECT count(*) AS count FROM index_jobs WHERE status='pending'").get()?.count, 0);
    assert.equal(db.prepare("SELECT request_hash FROM operations WHERE operation_id='original'").get()?.request_hash, null);
  } finally { db.close(); }
  assert.equal(JSON.stringify(await store.operationStatus("original")).includes("cobalt"), false);
});

test("disabled scopes reject ordinary reads/writes but retain data and metadata recovery", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  const saved = await store.remember(note(), "save");
  assert.ok(saved.recordId);
  await store.setDisabled(true, "off");
  assert.equal((await store.status()).disabled, true);
  assert.equal((await store.operationStatus("save")).status, "committed");
  for (const operation of [
    () => store.list(), () => store.search("cobalt"), () => store.inspect(saved.recordId!),
    () => store.remember(note(), "another"), () => store.correct(saved.recordId!, 1, note(), "edit"),
    () => store.forget(saved.recordId!, 1, "delete"),
  ]) await assert.rejects(operation(), { code: "STORE_DISABLED" });
  store.close();
  const restarted = await f.open();
  assert.equal((await restarted.status()).disabled, true);
  await restarted.setDisabled(false, "on");
  assert.equal((await restarted.list()).items.length, 1);
});

test("identical names, repositories and global scopes isolate records and operation IDs", async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  const global = await f.open(await f.bind("alpha", { kind: "global" }));
  const other = await f.open(await f.bind("alpha", { kind: "repository", root: f.otherRepository }));
  const foreign = await f.open(await f.bind("beta"));
  const saved = await first.remember(note(), "same-op");
  assert.ok(saved.recordId);
  for (const store of [global, other, foreign]) {
    assert.equal((await store.search("cobalt")).status, "no_match");
    assert.equal((await store.operationStatus("same-op")).status, "not_found");
    await assert.rejects(store.inspect(saved.recordId), { code: "NOT_FOUND" });
    await assert.rejects(store.forget(saved.recordId, 1, "foreign-delete"), { code: "NOT_FOUND" });
    await store.remember(note("different scope"), "same-op");
  }
  await first.setDisabled(true, "off");
  assert.equal((await global.list()).items.length, 1);
  const binding = await loadBinding(f.ref);
  await assert.rejects(MemoryStore.open(f.ref, { namespace: binding.namespace, scope: "global" }), { code: "SCOPE_MISMATCH" });
  assert.ok(first.path.startsWith(join(f.config, "agent-memories", binding.namespace)));
});

test("source checks roll back every table; URLs are syntax-only and file sources are scoped", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  const invalid = note();
  invalid.evidence = [{ kind: "tool_observation", reference: { type: "file", value: "missing.txt" } }];
  await assert.rejects(store.remember(invalid, "bad-source"), { code: "SOURCE_UNAVAILABLE" });
  assert.equal((await store.list()).items.length, 0);
  assert.equal((await store.operationStatus("bad-source")).status, "not_found");
  const saved = await store.remember(note(), "save");
  assert.ok(saved.recordId);
  await assert.rejects(store.correct(saved.recordId, 1, invalid, "bad-edit"), { code: "SOURCE_UNAVAILABLE" });
  assert.equal((await store.inspect(saved.recordId)).record.revision, 1);
  assert.equal((await store.search("cobalt")).items.length, 1);
  const file = join(f.repository, "source.txt");
  await writeFile(file, "invented source");
  const sourced = note();
  sourced.evidence = [{ kind: "tool_observation", reference: { type: "file", value: "source.txt" } }];
  await store.remember(sourced, "file-source");
  await rename(file, `${file}.moved`);
  assert.equal((await store.remember(sourced, "file-source")).replayed, true);
  await symlink(`${file}.moved`, join(f.otherRepository, "outside-link"));
  sourced.evidence[0]!.reference.value = join(f.otherRepository, "outside-link");
  // A symlink resolving inside the bound repository is permitted; outside targets are not.
  await writeFile(join(f.otherRepository, "outside.txt"), "synthetic");
  sourced.evidence[0]!.reference.value = join(f.otherRepository, "outside.txt");
  await assert.rejects(store.remember(sourced, "outside"), { code: "INVALID_SOURCE" });
  sourced.evidence = [{ kind: "user_statement", reference: { type: "url", value: "https://example.invalid/source" } }];
  const url = await store.remember(sourced, "url");
  assert.ok(url.recordId);
  assert.match(JSON.stringify((await store.inspect(url.recordId)).revisions), /syntax_only/);
  sourced.evidence[0]!.reference.value = "https://user:password@example.invalid";
  await assert.rejects(store.remember(sourced, "credentials"), { code: "INVALID_SOURCE" });
});

test("lost acknowledgement is recoverable after process restart and hot-journal rollback", async (t) => {
  const f = await fixture(t);
  const refFile = join(f.config, "storage-reference.json");
  await writeFile(refFile, JSON.stringify(f.ref), { mode: 0o600 });
  const result = await child(childScript, [refFile, "lost-ack"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  let store = await f.open();
  const committed = await store.operationStatus("child-save");
  assert.equal(committed.status, "committed");
  if (committed.status !== "committed") assert.fail("commit missing");
  await assert.rejects(acknowledge(committed, async () => { throw new Error("synthetic broken pipe"); }),
    { code: "OUTCOME_UNKNOWN", details: { operationId: "child-save" } });
  store.close();
  const crash = await child(childScript, [refFile, "crash"]);
  assert.equal(crash.code, 0, crash.stderr);
  store = await f.open();
  assert.equal((await store.search("uncommitted")).status, "no_match");
  assert.equal((await store.search("restart")).items.length, 1);
});

test("independent processes enforce expected revisions and held locks report busy", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  const saved = await store.remember(note(), "initial");
  assert.ok(saved.recordId);
  const refFile = join(f.config, "storage-reference.json");
  await writeFile(refFile, JSON.stringify(f.ref), { mode: 0o600 });
  const results = await Promise.all(["writer-a", "writer-b"].map((id) =>
    child(childScript, [refFile, "correct", saved.recordId!, id])));
  assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
  assert.match(results.find((result) => result.code !== 0)?.stderr ?? "", /REVISION_CONFLICT|STORE_BUSY/);
  assert.equal((await store.inspect(saved.recordId)).record.revision, 2);
  const lock = new DatabaseSync(store.path);
  try {
    lock.exec("BEGIN IMMEDIATE");
    await assert.rejects(store.remember(note(), "locked"), { code: "STORE_BUSY" });
    lock.exec("ROLLBACK");
  } finally { lock.close(); }
  assert.equal((await store.operationStatus("locked")).status, "not_found");
});

test("store permissions, symlinks, replacement and future schema fail closed", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  assert.equal((await lstat(store.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(store.path))).mode & 0o777, 0o700);
  await chmod(store.path, 0o644);
  await assert.rejects(store.list(), { code: "INSECURE_STORE" });
  await chmod(store.path, 0o600);
  const original = `${store.path}.original`;
  await rename(store.path, original);
  await writeFile(store.path, await readFile(original), { mode: 0o600 });
  await assert.rejects(store.list(), { code: "STORE_REPLACED" });
  store.close();
  const db = new DatabaseSync(store.path);
  db.exec("PRAGMA user_version=999");
  db.close();
  await assert.rejects(f.open(), { code: "SCHEMA_UNSUPPORTED" });
  await rename(store.path, `${store.path}.future`);
  await symlink(original, store.path);
  await assert.rejects(f.open(), { code: "INSECURE_STORE" });
});

test("revoked bindings and cancelled mutations cannot commit", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.remember(note(), "cancelled", controller.signal), { code: "CALL_CANCELLED" });
  assert.equal((await store.operationStatus("cancelled")).status, "not_found");
  await revokeBinding(f.ref);
  await assert.rejects(store.remember(note(), "revoked"), { code: "BINDING_REVOKED" });
});

test("local CLI requires scope, reads JSON from stdin, and supports the complete lifecycle", async (t) => {
  const f = await fixture(t);
  const args = await cliArgs(f.ref);
  const run = (command: string, extra: string[] = [], stdin?: string) => child(cli, [command, ...args, ...extra], stdin);
  const saved = await run("remember", ["--operation", "cli-save", "--input", "-"], JSON.stringify(note()));
  assert.equal(saved.code, 0, saved.stderr);
  const record = JSON.parse(saved.stdout) as { recordId: string };
  for (const [command, extra] of [
    ["list", []], ["search", ["--query", "cobalt"]], ["inspect", ["--record", record.recordId]],
    ["operation", ["--operation", "cli-save"]], ["status", []],
  ] satisfies [string, string[]][]) {
    const result = await run(command, extra);
    assert.equal(result.code, 0, result.stderr);
  }
  const corrected = await run("correct", ["--record", record.recordId, "--expected-revision", "1",
    "--operation", "cli-edit", "--input", "-"], JSON.stringify(note("updated synthetic")));
  assert.equal(corrected.code, 0, corrected.stderr);
  const forgotten = await run("forget", ["--record", record.recordId, "--expected-revision", "2", "--operation", "cli-forget"]);
  assert.equal(forgotten.code, 0, forgotten.stderr);
  assert.equal((await run("disable", ["--operation", "cli-off"])).code, 0);
  assert.equal((await run("list")).code, 1);
  assert.equal((await run("enable", ["--operation", "cli-on"])).code, 0);
  assert.equal((await run("status", ["--query", "not-allowed"])).code, 1);
  assert.equal((await child(cli, ["status"])).code, 1);
});
