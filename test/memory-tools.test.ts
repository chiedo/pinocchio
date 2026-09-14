import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { loadBinding } from "../src/binding-registry.js";
import { ContextLedger } from "../src/context-ledger.js";
import { MemoryStore } from "../src/memory-store.js";
import { MemoryWorker } from "../src/memory-worker-client.js";
import { createMemoryMcpServer, memoryLaunch } from "../src/memory-mcp.js";
import { CONTEXT_META, SAVE_TOOL, SEARCH_TOOL, saveSchema } from "../src/memory-protocol.js";
import { enroll, refreshEnrollment, removeEnrollment } from "../src/enrollment.js";
import { main as enrollmentMain } from "../src/enrollment-cli.js";
import { isRecord } from "../src/identity.js";
import { createProductionFixture } from "./support/production-fixture.js";

async function fixture(t: TestContext) {
  const f = await createProductionFixture();
  const ref = await f.bind("alpha");
  const binding = await loadBinding(ref);
  const store = await MemoryStore.open(ref, { namespace: binding.namespace, scope: binding.scope.kind });
  const ledger = await ContextLedger.open(f.config);
  let worker = new MemoryWorker();
  t.after(async () => { worker.close(); ledger.close(); store.close(); await f.close(); });
  const launch = memoryLaunch(ref);
  ledger.start("root", "foreground", "2026-01-01T00:00:00.000Z");
  async function call(args: unknown = { query: "synthetic" }, recipient = "foreground", tool = SEARCH_TOOL, directory = f.repository) {
    const ticket = ledger.issue({ root: "root", recipient, server: launch.serverName, tool,
      directory,
      call: "synthetic-call", arguments: args, deadline: Date.now() + 1_000 });
    const result = await worker.call({ action: "tool", reference: ref, server: launch.serverName, tool, arguments: args, ticket });
    assert.ok(isRecord(result));
    return result;
  }
  for (let index = 0; index < 4; index++) await store.remember({
    content: `synthetic note ${index}`, kind: "fact",
    evidence: [{ kind: "manual_entry", reference: { type: "text", value: "invented fixture" } }],
  }, `seed-${index}`);
  return { ...f, ref, store, ledger, call, launch,
    restart() { worker.close(); worker = new MemoryWorker(); } };
}
test("memory snippets and recipient budgets persist across worker restart and compaction", async (t) => {
  const f = await fixture(t);
  const first = await f.call();
  assert.equal(first.status, "ok");
  assert.ok(Array.isArray(first.snippets));
  assert.ok(first.snippets.length > 0 && first.snippets.length <= 3);
  assert.ok(Buffer.byteLength(JSON.stringify(first.snippets)) <= 800);
  assert.equal(first.chargedTokens, Buffer.byteLength(JSON.stringify(first.snippets)));
  f.restart();
  const repeated = await f.call();
  assert.ok(["already_delivered", "budget_exhausted"].includes(String(repeated.status)));
  assert.equal(repeated.sessionRemaining, first.sessionRemaining);
  f.ledger.invalidate("root");
  const compacted = await f.call();
  assert.equal(compacted.status, "budget_exhausted");
  f.ledger.start("root", "helper", "2026-01-01T00:00:01.000Z");
  const helper = await f.call(undefined, "helper");
  assert.equal(helper.status, "ok");
  assert.ok(Number(helper.sessionRemaining) < Number(first.sessionRemaining));
});
test("session budget includes helpers and cannot reset through new recipient requests", async (t) => {
  const f = await fixture(t);
  let spent = 0;
  let exhausted = false;
  for (let index = 0; index < 12; index++) {
    const recipient = `helper-${index}`;
    f.ledger.start("root", recipient, `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`);
    const result = await f.call(undefined, recipient);
    spent += Number(result.chargedTokens ?? 0);
    if (result.status === "budget_exhausted") exhausted = true;
  }
  assert.ok(exhausted);
  assert.ok(spent <= 6_000);
  f.restart();
  f.ledger.start("root", "last-helper", "2026-01-01T00:01:00.000Z");
  assert.equal((await f.call(undefined, "last-helper")).status, "budget_exhausted");
});
test("compaction redelivery is charged again without resetting usage or restart deduplication", async (t) => {
  const f = await fixture(t);
  const first = await f.call({ query: "note 0" });
  assert.equal(first.status, "ok");
  assert.equal((await f.call({ query: "note 0" })).status, "already_delivered");
  f.ledger.invalidate("root");
  const again = await f.call({ query: "note 0" });
  assert.equal(again.status, "ok");
  assert.equal(Number(again.sessionRemaining), Number(first.sessionRemaining) - Number(again.chargedTokens));
  assert.equal(Number(again.requestRemaining), Number(first.requestRemaining) - Number(again.chargedTokens));
  f.restart();
  assert.equal((await f.call({ query: "note 0" })).status, "already_delivered");
});
test("signed context rejects model overrides, altered arguments and stale request tickets", async (t) => {
  const f = await fixture(t);
  const args = { query: "synthetic" };
  const ticket = f.ledger.issue({ root: "root", recipient: "foreground", server: f.launch.serverName,
    directory: f.repository,
    tool: SEARCH_TOOL, call: "call", arguments: args, deadline: Date.now() + 1_000 });
  assert.throws(() => f.ledger.verify({ ...ticket, recipient: "other" }, f.launch.serverName, SEARCH_TOOL, args),
    { code: "INVALID_REQUEST_CONTEXT" });
  assert.throws(() => f.ledger.verify(ticket, f.launch.serverName, SEARCH_TOOL, { query: "changed" }),
    { code: "INVALID_REQUEST_CONTEXT" });
  f.ledger.start("root", "foreground", "2026-01-01T00:00:02.000Z");
  assert.throws(() => f.ledger.verify(ticket, f.launch.serverName, SEARCH_TOOL, args), { code: "STALE_REQUEST" });
  await assert.rejects(f.call({ query: "synthetic", namespace: "foreign" }), { code: "INVALID_INPUT" });
  await assert.rejects(f.call(undefined, "foreground", SEARCH_TOOL, f.otherRepository), { code: "REQUEST_SCOPE_MISMATCH" });
});
test("worker save receipts survive restart; correction and disabled reads remain explicit", async (t) => {
  const f = await fixture(t);
  const args = { action: "remember", operationId: "tool-save", note: {
    content: "synthetic saved through worker", kind: "decision",
    evidence: [{ kind: "manual_entry", reference: { type: "text", value: "fixture" } }],
  } };
  const saved = await f.call(args, "foreground", SAVE_TOOL);
  assert.equal(saved.status, "committed");
  f.restart();
  assert.equal((await f.call(args, "foreground", SAVE_TOOL)).replayed, true);
  assert.equal((await f.call({ action: "status", operationId: "tool-save" }, "foreground", SAVE_TOOL)).status, "committed");
  await f.store.setDisabled(true, "disable");
  await assert.rejects(f.call(), { code: "STORE_DISABLED" });
});
test("MCP uses bound process context when host hooks are unavailable and rejects malformed context", async (t) => {
  const f = await fixture(t);
  const server = createMemoryMcpServer(f.ref, f.launch.serverName, f.repository);
  const client = new Client({ name: "synthetic", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const listed = await client.listTools();
  const save = listed.tools.find((tool) => tool.name === SAVE_TOOL);
  assert.ok(save);
  assert.deepEqual(save.inputSchema.required, ["action", "operationId"]);
  assert.deepEqual(save.inputSchema.properties?.action, { type: "string", enum: ["remember", "correct", "status"] });
  assert.deepEqual(Object.keys(save.inputSchema.properties ?? {}).sort(),
    ["action", "expectedRevision", "note", "operationId", "recordId"]);
  const strict = z.toJSONSchema(saveSchema, { io: "input", unrepresentable: "any" });
  assert.ok(Array.isArray(strict.oneOf));
  assert.deepEqual(save.inputSchema.oneOf, strict.oneOf);
  assert.equal(save.inputSchema.additionalProperties, false);
  const direct = await client.callTool({ name: SEARCH_TOOL, arguments: { query: "synthetic" } });
  assert.equal(direct.isError, false);
  const denied = await client.callTool({ name: SEARCH_TOOL, arguments: { query: "synthetic" },
    _meta: { [CONTEXT_META]: {} } });
  assert.equal(denied.isError, true);
  const args = { query: "synthetic" };
  const ticket = f.ledger.issue({ root: "root", recipient: "foreground", server: f.launch.serverName,
    directory: f.repository,
    tool: SEARCH_TOOL, call: "mcp-call", arguments: args, deadline: Date.now() + 1_000 });
  const result = await client.callTool({ name: SEARCH_TOOL, arguments: args, _meta: { [CONTEXT_META]: ticket } });
  assert.equal(result.isError, false);
});
test("enrollment preserves defaults and unrelated edits; removal only removes managed content", async (t) => {
  const f = await fixture(t);
  const path = join(f.definitions.alpha.root, "shared.agent.md");
  await writeFile(path, "---\nname: shared\ndescription: Synthetic\ntools: [view]\nmodel: synthetic-native\nreasoning-effort: high\n---\nOriginal instructions.\n");
  assert.equal((await enroll(f.ref)).status, "enrolled");
  let contents = await readFile(path, "utf8");
  assert.match(contents, /model: synthetic-native/);
  assert.match(contents, /reasoning-effort: high/);
  assert.match(contents, /pinocchio-memory:v1/);
  assert.ok(contents.includes('- Agent ID: "shared"'));
  assert.ok(contents.includes(`- Agent profile: ${JSON.stringify(path)}`));
  assert.ok(contents.includes(`- Memory scope: repository ${JSON.stringify(f.repository)}`));
  contents += "\nUnrelated new instructions.\n";
  await writeFile(path, contents);
  await removeEnrollment(f.ref);
  const removed = await readFile(path, "utf8");
  assert.match(removed, /Original instructions/);
  assert.match(removed, /Unrelated new instructions/);
  assert.match(removed, /model: synthetic-native/);
  assert.doesNotMatch(removed, /pinocchio-memory:v1|agent_memory_search|Your Pinocchio agent/);
  assert.equal((await f.store.list()).items.length, 4);
});
test("enrollment refuses implicit broad access and unapproved shared profiles", async (t) => {
  const f = await fixture(t);
  await assert.rejects(enroll(f.ref), { code: "EXPLICIT_TOOL_LIST_REQUIRED" });
  await assert.rejects(enroll(await f.bind("beta")), { code: "EXPLICIT_SHARED_ENROLLMENT_REQUIRED" });
});
test("legacy enrollment can still be removed without a refresh", async (t) => {
  const f = await fixture(t);
  const path = join(f.definitions.alpha.root, "shared.agent.md");
  await writeFile(path, "---\nname: shared\ndescription: Synthetic\ntools: [view]\n---\nKeep this role.\n");
  await enroll(f.ref);
  const legacy = (await readFile(path, "utf8"))
    .replace(/## Your Pinocchio agent\n[\s\S]*?(?=## Persistent memory)/, "");
  assert.doesNotMatch(legacy, /## Your Pinocchio agent/);
  await writeFile(path, legacy);
  await removeEnrollment(f.ref, true);
  assert.equal(await readFile(path, "utf8"), legacy);
  await removeEnrollment(f.ref);
  const removed = await readFile(path, "utf8");
  assert.match(removed, /Keep this role/);
  assert.doesNotMatch(removed, /pinocchio-memory:|agent_memory_search/);
  assert.equal((await f.store.list()).items.length, 4);
});
test("refresh refuses changed servers and duplicate managed blocks without rewriting the profile", async (t) => {
  const f = await fixture(t);
  const path = join(f.definitions.alpha.root, "shared.agent.md");
  await writeFile(path, "---\nname: shared\ndescription: Synthetic\ntools: [view]\n---\nKeep this role.\n");
  await enroll(f.ref);
  const original = await readFile(path, "utf8");
  const changedServer = original.replace(f.ref.fingerprint, "0".repeat(64));
  assert.notEqual(changedServer, original);
  await writeFile(path, changedServer);
  await assert.rejects(refreshEnrollment(f.ref), { code: "MANAGED_SERVER_CHANGED" });
  assert.equal(await readFile(path, "utf8"), changedServer);
  const block = original.slice(original.indexOf("<!-- pinocchio-memory:v1 -->"));
  const duplicated = original + block;
  await writeFile(path, duplicated);
  await assert.rejects(refreshEnrollment(f.ref), { code: "MANAGED_BLOCK_CHANGED" });
  assert.equal(await readFile(path, "utf8"), duplicated);
});
test("shared agents get their actual profile paths and require explicit permission to refresh", async (t) => {
  const f = await fixture(t);
  for (const origin of ["foreground", "beta"] as const) {
    const path = join(f.definitions[origin].root, "shared.agent.md");
    await writeFile(path, "---\nname: Different display name\ndescription: Synthetic\ntools: [view]\n---\nKeep this role.\n");
    const ref = await f.bind(origin);
    await enroll(ref, true);
    const modern = await readFile(path, "utf8");
    assert.ok(modern.includes('- Agent ID: "shared"'));
    assert.ok(modern.includes(`- Agent profile: ${JSON.stringify(path)}`));
    assert.ok(modern.includes(`- Memory scope: repository ${JSON.stringify(f.repository)}`));
    const legacy = modern.replace(/## Your Pinocchio agent\n[\s\S]*?(?=## Persistent memory)/, "");
    await writeFile(path, legacy);
    await assert.rejects(refreshEnrollment(ref), { code: "EXPLICIT_SHARED_ENROLLMENT_REQUIRED" });
    assert.equal(await readFile(path, "utf8"), legacy);
    const args = ["refresh", "--config-root", f.config, "--binding", ref.bindingId,
      "--fingerprint", ref.fingerprint, "--allow-shared"];
    const refreshed = await enrollmentMain(args);
    assert.equal(refreshed.status, "refreshed");
    assert.ok("updated" in refreshed && refreshed.updated === true);
    assert.equal(await readFile(path, "utf8"), modern);
    const repeated = await enrollmentMain(args);
    assert.ok("updated" in repeated && repeated.updated === false);
    assert.equal(await readFile(path, "utf8"), modern);
  }
});
test("new-profile helper enrolls memory without overriding native defaults", async (t) => {
  const f = await fixture(t);
  const path = join(f.definitions.alpha.root, "created-agent.agent.md");
  const result = await enrollmentMain(["create", "--config-root", f.config,
    "--definition", path, "--origin-root", f.definitions.alpha.root, "--name", "created-agent",
    "--repository", f.repository]);
  assert.equal(result.status, "enrolled");
  const content = await readFile(path, "utf8");
  assert.match(content, /pinocchio-memory:v1/);
  assert.match(content, /agent_memory_search/);
  assert.ok(content.includes('- Agent ID: "created-agent"'));
  assert.ok(content.includes(`- Agent profile: ${JSON.stringify(path)}`));
  assert.doesNotMatch(content, /^model:|^reasoning-effort:/m);
  await assert.rejects(enrollmentMain(["remove", "--config-root", f.config,
    "--binding", f.ref.bindingId, "--fingerprint", f.ref.fingerprint, "--global"]), { code: "INVALID_ARGUMENTS" });
});
test("bounded worker queue, cancellation and deadlines fail explicitly", async () => {
  const worker = new MemoryWorker();
  try {
    await assert.rejects(worker.call({}, Date.now() - 1), { code: "MEMORY_DEADLINE" });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(worker.call({}, Date.now() + 1_000, abort.signal), { code: "CALL_CANCELLED" });
    const pending = Array.from({ length: 12 }, () => worker.call({}, Date.now() + 1_000));
    const results = await Promise.allSettled(pending);
    assert.ok(results.some((result) => result.status === "rejected" &&
      isRecord(result.reason) && result.reason.code === "QUEUE_FULL"));
    const late = worker.call({}, Date.now() + 5);
    const started = performance.now();
    while (performance.now() - started < 15) { /* Exercise a delayed parent event loop, not slow database work. */ }
    await assert.rejects(late, { code: "MEMORY_DEADLINE" });
  } finally { worker.close(); }
});
