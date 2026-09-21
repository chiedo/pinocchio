import assert from "node:assert/strict";
import test from "node:test";
import { recentConversationWindow, resolveMemorySearch } from "../src/memory-query.js";
import { searchSchema } from "../src/memory-protocol.js";

const now = Date.parse("2026-05-12T14:00:00Z");
test("recap questions use time windows rather than treating timestamps as keywords", () => {
  for (const query of [
    "What did we discuss in the past 15 minutes?",
    "What's the last thing we talked about in the past 15m?",
  ]) {
    assert.deepEqual(recentConversationWindow(query, now), {
      since: "2026-05-12T13:45:00.000Z", before: "2026-05-12T14:00:00.000Z",
    });
  }
  assert.deepEqual(recentConversationWindow(
    "What did the user and the assistant discuss in the last 15 minutes before 2026-05-12T09:00:00-04:00?", now), {
    since: "2026-05-12T12:45:00.000Z", before: "2026-05-12T13:00:00.000Z",
  });
  assert.equal(resolveMemorySearch({ query: "What did we just discuss?" }, now).mode, "recent");
  assert.equal(resolveMemorySearch({ query: "What were we just talking about?" }, now).mode, "recent");
  assert.equal(resolveMemorySearch({ query: "Explain recent conversation capture" }, now).mode, "topic");
  assert.equal(resolveMemorySearch({ query: "What did we just discuss?", mode: "topic" }, now).mode, "topic");
  assert.equal(resolveMemorySearch({ query: "What did we say about maple syrup?" }, now).mode, "topic");
});
test("structured recent search validates bounds and retains query-only compatibility", () => {
  assert.ok(searchSchema.safeParse({ query: "mascot" }).success);
  assert.ok(searchSchema.safeParse({ mode: "recent" }).success);
  assert.ok(!searchSchema.safeParse({}).success);
  assert.ok(!searchSchema.safeParse({ mode: "topic" }).success);
  assert.ok(!searchSchema.safeParse({ query: "x", since: "2026-05-12T00:00:00Z" }).success);
  assert.ok(!searchSchema.safeParse({ mode: "recent", since: "yesterday" }).success);
  assert.ok(!searchSchema.safeParse({ mode: "recent", since: "2026-05-13T00:00:00Z", before: "2026-05-12T00:00:00Z" }).success);
  assert.ok(!searchSchema.safeParse({ mode: "recent", agent: "someone-else" }).success);
  assert.deepEqual(resolveMemorySearch({ mode: "recent", since: "2026-05-12T09:45:00-04:00" }, now), {
    mode: "recent", window: { since: "2026-05-12T13:45:00.000Z", before: "2026-05-12T14:00:00.000Z" },
  });
  for (const args of [
    { mode: "recent" as const, since: "2020-01-01T00:00:00Z" },
    { mode: "recent" as const, since: "2027-01-01T00:00:00Z" },
    { query: "What did we discuss in the past 0 minutes?" },
    { query: "What did we discuss in the past 31 days?" },
    { query: "What did we discuss in the past 15 minutes before 2026-02-30T10:00:00Z?" },
  ]) assert.throws(() => resolveMemorySearch(args, now), { code: "INVALID_INPUT" });
});
