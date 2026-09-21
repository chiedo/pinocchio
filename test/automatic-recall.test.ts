import assert from "node:assert/strict";
import test from "node:test";
import { automaticRecallQuery, rankAutomaticRecall } from "../src/automatic-recall.js";
import { loadBinding } from "../src/binding-registry.js";
import { captureConversation, setConversationEnabled } from "../src/conversation-memory.js";
import { ContextLedger } from "../src/context-ledger.js";
import { createMemoryHooks } from "../src/memory-hooks.js";
import { EXTENSION_MEMORY_SERVER } from "../src/memory-protocol.js";
import { MemoryStore } from "../src/memory-store.js";
import { createProductionFixture } from "./support/production-fixture.js";

test("automatic queries inherit nearby context only for short follow-ups", () => {
  const prior = ["Can you confirm Kestrel conversation recall is available?"];
  assert.equal(automaticRecallQuery("Make suggestions for improving relevance", prior),
    "kestrel conversation recall relevance");
  assert.equal(automaticRecallQuery("How can we improve bread baking?", prior), "bread baking");
  for (const prompt of ["Thanks!", "OK", "Can you help with work?"]) {
    assert.equal(automaticRecallQuery(prompt, prior), undefined);
  }
  assert.equal(automaticRecallQuery("LARCH-704"), "larch 704");
  assert.ok(!automaticRecallQuery("Improve it", ["excluded older topic", ...prior, "Improve relevance"])?.includes("excluded"));
});

test("automatic ranking gates relevance before recency and ignores capture metadata", () => {
  const row = (id: string, content: string, date: string) => ({
    id, content, revision: 1, source_at: date, confirmed_at: null, recorded_at: date,
  });
  const strong = row("strong", "Kestrel memory ranking follows the documented decision.", "2026-05-01T00:00:00Z");
  const partial = row("partial", "Kestrel memory notes.", "2026-05-03T00:00:00Z");
  const weak = row("weak", "Kestrel recording instructions.", "2026-05-04T00:00:00Z");
  const noise = row("noise", "Record meetings and transcribe audio.", "2026-05-05T00:00:00Z");
  assert.deepEqual(rankAutomaticRecall("Kestrel memory ranking", [noise, weak, partial, strong], []).map((item) => item.id),
    ["strong", "partial"]);
  assert.deepEqual(rankAutomaticRecall("help with work", [noise], []), []);
  assert.deepEqual(rankAutomaticRecall("2026 kestrel", [
    row("metadata", "[user 2026-05-05T00:00:00Z] Kestrel", "2026-05-05T00:00:00Z"),
  ], []), []);
  assert.deepEqual(rankAutomaticRecall("Kestrel memory", [
    { ...partial, id: "older", source_at: strong.source_at }, partial,
  ], []).map((item) => item.id), ["partial", "older"]);
  assert.deepEqual(rankAutomaticRecall("meeting transcripts", [noise], [
    { id: "noise", revision: 1, score: 0.7 },
  ]).map((item) => item.id), ["noise"]);
  assert.deepEqual(rankAutomaticRecall("meeting transcripts", [noise], [
    { id: "noise", revision: 1, score: 0.2 },
  ]), []);
  assert.deepEqual(rankAutomaticRecall("meeting transcripts", [noise], [
    { id: "noise", revision: 2, score: 0.9 },
  ]), []);
});

test("automatic hooks use bounded context, abstain, preserve recaps, and clear context at isolation boundaries", async () => {
  const f = await createProductionFixture();
  const reference = await f.bind("alpha", { kind: "global" });
  const otherReference = await f.bind("beta", { kind: "global" });
  const binding = await loadBinding(reference);
  const store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: "global" });
  const hooks = createMemoryHooks(f.config);
  const ledger = await ContextLedger.open(f.config);
  const owner = { reference, server: EXTENSION_MEMORY_SERVER };
  let sequence = 0;
  async function recall(prompt: string, selected = owner, directory = f.repository, sessionId = "current") {
    ledger.start(sessionId, sessionId, new Date(Date.UTC(2026, 0, 1) + ++sequence * 1_000).toISOString());
    return hooks.recall(selected, { prompt, directory, sessionId });
  }
  const topic = "Can you confirm Kestrel memory recall is available?";
  const followup = "Make suggestions for improving relevance";
  try {
    await store.remember({
      content: "Kestrel memory ranking uses TOPAZ-319.", kind: "decision",
      evidence: [{ kind: "user_statement", reference: { type: "text", value: "synthetic source" } }],
    }, "decision");
    await captureConversation(reference, { sessionId: "earlier", id: "recording",
      timestamp: new Date(Date.now() - 1_000).toISOString(), role: "user",
      content: "Record meetings and transcribe audio using QUARTZ-218.", directory: f.repository });
    assert.equal(await recall("Can you help with work?"), "");
    assert.equal(await recall("How do telescopes align?"), "");
    assert.match(await recall(topic), /TOPAZ-319/);
    const related = await recall(followup);
    assert.match(related, /TOPAZ-319/);
    assert.doesNotMatch(related, /QUARTZ-218/);
    assert.equal(await recall("How can we improve bread baking?"), "");
    assert.equal(await recall(followup), "");

    await recall(topic);
    hooks.resetRecall();
    assert.equal(await recall(followup), "");
    await recall(topic);
    assert.equal(await recall(followup, owner, f.otherRepository), "");
    await recall(topic);
    assert.equal(await recall(followup, owner, f.repository, "fresh-session"), "");
    await recall(topic);
    assert.equal(await recall(followup, { reference: otherReference, server: EXTENSION_MEMORY_SERVER }), "");
    assert.equal(await recall(followup), "");
    await recall(topic);
    await setConversationEnabled(reference, false);
    assert.equal(await recall(followup), "");
    await setConversationEnabled(reference, true);
    assert.equal(await recall(followup), "");
    assert.match(await recall("What did we discuss in the past 15 minutes?"), /QUARTZ-218/);
    assert.equal(await recall("Thanks!"), "");
    assert.match(await recall("Kestrel"), /TOPAZ-319/);
  } finally { hooks.close(); ledger.close(); store.close(); await f.close(); }
});
