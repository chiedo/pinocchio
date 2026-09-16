import assert from "node:assert/strict";
import test from "node:test";
import { loadBinding } from "../src/binding-registry.js";
import {
  setConversationEnabled,
} from "../src/conversation-memory.js";
import { MemoryStore } from "../src/memory-store.js";
import { createConversationFixture } from "./support/conversation-fixture.js";

test("paused automatic capture remains disabled and isolated across agents", {
  timeout: 120_000,
}, async () => {
  const f = await createConversationFixture([
    "automatic-alpha",
    "automatic-beta",
  ]);
  try {
    const client = f.createClient();
    const seed = await f.open(client, "automatic-alpha");
    await f.turn(seed, "The synthetic mascot is Indigo Heron.");
    const reference = f.references.get("automatic-alpha");
    assert.ok(reference);
    await setConversationEnabled(reference, false);
    await f.disconnect(seed);

    const pausedSession = await f.open(client, "automatic-alpha");
    const paused = await f.turn(
      pausedSession,
      "What was the mascot? Also: paused sentinel.",
    );
    assert.doesNotMatch(paused, /Indigo Heron/);
    await pausedSession.rpc.agent.select({ name: "automatic-beta" });
    await pausedSession.rpc.tools.initializeAndValidate();
    const isolated = await f.turn(pausedSession, "What was the mascot?");
    assert.doesNotMatch(isolated, /Indigo Heron/);

    const binding = await loadBinding(reference);
    const store = await MemoryStore.open(reference, {
      namespace: binding.namespace,
      scope: "global",
    });
    try {
      assert.equal((await store.search("paused sentinel")).items.length, 0);
    } finally {
      store.close();
    }
    assert.equal(f.provider.counts().toolRequests, 0);
    assert.equal(f.provider.counts().failures, 0);
  } finally {
    await f.close();
  }
});
