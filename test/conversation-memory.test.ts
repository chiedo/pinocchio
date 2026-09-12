import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setup } from "../src/setup-cli.js";
import { loadBinding } from "../src/binding-registry.js";
import type { BindingReference } from "../src/binding-registry.js";
import { captureConversation, conversationOwner, recallConversation, redactConversation, setConversationEnabled } from "../src/conversation-memory.js";
import { MemoryStore } from "../src/memory-store.js";
import { MemoryWorker } from "../src/memory-worker-client.js";
import { memoryLaunch } from "../src/memory-mcp.js";
import { SEARCH_TOOL } from "../src/memory-protocol.js";

test("capture persists without model saves; next-session recall is automatic and scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-conversation-"));
  const worker = new MemoryWorker();
  try {
    await setup({ configRoot: root, name: "synthetic-conversation", global: true });
    const reference = JSON.parse(await readFile(join(root, "pinocchio/setup/synthetic-conversation.json"), "utf8")) as BindingReference;
    const binding = await loadBinding(reference);
    const launch = memoryLaunch(reference);
    const owner = { reference, server: launch.serverName };
    const current = { agent: { path: binding.definition.path,
      tools: [`${launch.serverName}-${SEARCH_TOOL}`], mcpServers: { [launch.serverName]: launch.config } } };
    assert.deepEqual(await conversationOwner(root, current), owner);
    assert.equal(await conversationOwner(root, { agent: { ...current.agent, path: "/not/the/agent.agent.md" } }), undefined);
    assert.equal(await conversationOwner(root, {}), undefined);
    const message = { sessionId: randomUUID(), id: randomUUID(), timestamp: new Date().toISOString(),
      role: "user" as const, content: "The synthetic mascot is Amber Otter.", directory: process.cwd() };
    assert.equal((await captureConversation(reference, message)).status, "committed");
    assert.equal((await captureConversation(reference, message)).status, "committed");
    let store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: "global" });
    let record;
    try {
      const items = (await store.list()).items;
      assert.equal(items.length, 1);
      record = items[0];
      assert.ok(record);
    } finally { store.close(); }
    const sessionId = randomUUID();
    await worker.call({ action: "start", configRoot: root, root: sessionId, recipient: sessionId, stamp: new Date().toISOString() });
    assert.match(await recallConversation(worker, owner, {
      sessionId, directory: process.cwd(), prompt: "What was the mascot?",
    }), /Amber Otter/);
    await setConversationEnabled(reference, false);
    assert.equal((await captureConversation(reference, { ...message, id: randomUUID(), content: "Paused content" })).status, "paused");
    assert.equal(await recallConversation(worker, owner, { sessionId, directory: process.cwd(), prompt: "mascot" }), "");
    await setConversationEnabled(reference, true);
    store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: "global" });
    try { await store.forget(record.id, record.revision, randomUUID()); } finally { store.close(); }
    await captureConversation(reference, message);
    store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: "global" });
    try { assert.equal((await store.search("Amber Otter")).items.length, 0); } finally { store.close(); }
    await captureConversation(reference, {
      ...message, id: randomUUID(), role: "assistant", content: "This is an unverified assistant guess.",
    });
    await captureConversation(reference, {
      ...message, id: randomUUID(), timestamp: "2000-01-01T00:00:00Z", content: "Expired synthetic conversation",
    });
    store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: "global" });
    try {
      assert.equal((await store.search("Expired synthetic conversation")).items.length, 0);
      assert.equal((await store.search("unverified assistant guess")).items[0]?.status, "tentative");
    } finally { store.close(); }
  } finally { worker.close(); await rm(root, { recursive: true }); }
});

test("conversation redaction removes recognized credentials and identifiers", () => {
  const input = `api_key="invented-secret" password=not-real\nBearer ${"a".repeat(30)}
ghp_${"b".repeat(30)} person@example.test 123-45-6789
-----BEGIN PRIVATE KEY-----\ninvented\n-----END PRIVATE KEY-----`;
  const redacted = redactConversation(input);
  for (const sensitive of ["invented-secret", "not-real", "a".repeat(30), "b".repeat(30), "person@example.test", "123-45-6789"]) {
    assert.ok(!redacted.includes(sensitive));
  }
  assert.ok(!redacted.includes("-----BEGIN PRIVATE KEY-----"));
});
