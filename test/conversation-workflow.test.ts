import assert from "node:assert/strict";
import test from "node:test";
import { loadBinding } from "../src/binding-registry.js";
import { MemoryStore } from "../src/memory-store.js";
import { createConversationFixture } from "./support/conversation-fixture.js";

test("native cold-session recap recalls captured history without topic keywords or model memory calls", {
  timeout: 120_000,
}, async () => {
  const f = await createConversationFixture(["automatic-alpha"]);
  try {
    let client = f.createClient();
    const captured = await f.open(client, "automatic-alpha");
    await f.turn(captured, "The synthetic mascot is Indigo Heron.");
    await f.disconnect(captured);
    await f.stop(client);

    const reference = f.references.get("automatic-alpha");
    assert.ok(reference);
    const binding = await loadBinding(reference);
    const store = await MemoryStore.open(reference, {
      namespace: binding.namespace,
      scope: "global",
    });
    try {
      assert.ok(
        (await store.search("Indigo Heron")).items.length > 0,
        "USER_EVENT_NOT_CAPTURED",
      );
    } finally {
      store.close();
    }

    client = f.createClient();
    const recalledSession = await f.open(client, "automatic-alpha");
    const recalled = await f.turn(recalledSession, "What did we discuss in the past 15 minutes?");
    assert.match(recalled, /Pinocchio conversation memory/);
    assert.match(recalled, /Indigo Heron/);
    assert.equal(f.provider.counts().toolRequests, 0);
    assert.equal(f.provider.counts().failures, 0);
  } finally {
    await f.close();
  }
});
