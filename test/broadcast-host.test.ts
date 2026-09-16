import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { broadcastStatus } from "../src/broadcast.js";
import { upgradeBroadcast } from "../src/broadcast-cli.js";
import { EXTENSION_SEARCH_TOOL } from "../src/memory-protocol.js";
import {
  createBroadcastFixture,
  sessionChat as chat,
  sessionWarnings as warnings,
} from "./support/broadcast-fixture.js";

test("native refresh is silent across startup, ongoing work, reload, and agent selection", { timeout: 240_000 }, async () => {
  const observed: { all: string; latest: string }[] = [];
  let release: () => void = () => {};
  let started: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const f = await createBroadcastFixture({
    async observeRequest(messages) {
      observed.push({ all: JSON.stringify(messages), latest: JSON.stringify(messages.findLast((message) => message.role === "user") ?? {}) });
      if (observed.length === 1) { started(); await blocked; }
    },
  });
  let working: Promise<unknown> | undefined;
  try {
    const [first, second] = await Promise.all([
      f.openSession(),
      f.openSession(),
    ]);
    await f.waitFor((status) => status.sessions.length === 2);
    const before = (await first.rpc.agent.getCurrent()).agent;
    working = first.sendAndWait({ prompt: "Keep working on this ordinary task." }, 45_000);
    await Promise.race([waiting, working.then(() => { throw new Error("REQUEST_NOT_OBSERVED"); })]);
    await writeFile(f.profile, (await readFile(f.profile, "utf8")).replace("Synthetic original role marker.", "Synthetic refreshed role marker."));
    await writeFile(f.shared, (await readFile(f.shared, "utf8")) + "\nSynthetic shared refresh marker.\n");
    await upgradeBroadcast(f.config);
    await f.waitFor((status) => status.sessions.length === 2 &&
      status.sessions.every((item) => item.status === "updated"));
    assert.equal(f.provider.counts().requests, 1, "Refreshing must not call the model or interrupt active work");
    assert.equal((await chat(first)).length, 1, "The blocked user turn must remain the only chat event");
    assert.deepEqual(await chat(second), []);
    const after = (await first.rpc.agent.getCurrent()).agent;
    assert.ok(before && after);
    const { prompt: _beforePrompt, ...beforeSettings } = before;
    const { prompt: _afterPrompt, ...afterSettings } = after;
    assert.deepEqual(afterSettings, beforeSettings, "Refresh must not change agent settings or permissions");
    release();
    await working;
    working = undefined;
    await f.waitFor((status) => status.sessions.length === 2 && status.sessions.every((item) => item.status === "updated"));
    assert.equal((await chat(first)).length, 2, "The original user task must finish normally");

    const [restarted, other] = await Promise.all([
      f.openSession(),
      f.openSession(undefined, "other-agent"),
    ]);
    await f.waitFor((status) => status.sessions.length === 4 &&
      status.sessions.every((item) => item.status === "updated"));
    assert.deepEqual(await chat(restarted), [], "Opening a new agent must not replay a saved broadcast into chat");
    assert.deepEqual(await chat(other), []);
    assert.equal(f.provider.counts().requests, 1);
    assert.ok((await broadcastStatus(f.config)).sessions
      .filter((item) => item.agent === "broadcast-agent")
      .every((item) =>
      item.unmatchedTools?.includes("web_search") && item.unmatchedTools.includes("exec") &&
      item.missingTools === undefined && item.code === undefined));
    const broadcastSessions = [first, second, restarted];
    const beforeRefreshChecks = observed.length;
    for (const session of broadcastSessions) {
      assert.deepEqual(await warnings(session), []);
      await session.sendAndWait({ prompt: "Continue the ordinary task, without changing any files." }, 20_000);
      let search = await session.rpc.tools.execute({
        name: EXTENSION_SEARCH_TOOL, arguments: { query: "Synthetic shared refresh marker" },
      });
      const deadline = Date.now() + 2_000;
      while (typeof search !== "string" && search.resultType !== "success" &&
          Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        search = await session.rpc.tools.execute({
          name: EXTENSION_SEARCH_TOOL,
          arguments: { query: "Synthetic shared refresh marker" },
        });
      }
      assert.notEqual(typeof search, "string");
      if (typeof search === "string") throw new Error("UNSTRUCTURED_SEARCH");
      assert.equal(search.resultType, "success", JSON.stringify({
        sessionId: session.sessionId,
        search,
      }));
      assert.deepEqual(JSON.parse(search.textResultForLlm).snippets, [], "Instructions must not be captured as memories");
    }
    const refreshedRequests = observed.slice(beforeRefreshChecks);
    assert.equal(refreshedRequests.length, broadcastSessions.length);
    for (const request of refreshedRequests) {
      assert.match(request.all, /Synthetic refreshed role marker/);
      assert.match(request.all, /Synthetic shared refresh marker/);
      assert.doesNotMatch(request.all, /Synthetic original role marker/);
    }
    const chatCounts = await Promise.all(f.sessions.map(async (session) => (await chat(session)).length));
    await upgradeBroadcast(f.config);
    await f.waitFor((status) => status.sessions.length === 4 && status.sessions.every((item) => item.status === "updated"));
    await restarted.rpc.extensions.reload();
    await restarted.rpc.agent.select({ name: "broadcast-agent" });
    await restarted.rpc.tools.initializeAndValidate();
    await f.waitFor((status) => status.sessions.length === 4 && status.sessions.every((item) => item.status === "updated"));
    await restarted.rpc.agent.select({ name: "other-agent" });
    await restarted.rpc.tools.initializeAndValidate();
    await f.waitFor((status) => status.sessions.some((item) => item.sessionId === restarted.sessionId && item.agent === "other-agent" && item.status === "updated"));
    await restarted.rpc.agent.deselect();
    await f.waitFor((status) => status.sessions.length === 3);
    await restarted.rpc.agent.select({ name: "broadcast-agent" });
    await restarted.rpc.tools.initializeAndValidate();
    await f.waitFor((status) => status.sessions.length === 4 && status.sessions.every((item) => item.status === "updated"));
    assert.deepEqual(await Promise.all(f.sessions.map(async (session) => (await chat(session)).length)), chatCounts);
    assert.equal(f.provider.counts().requests, 4);
    await restarted.sendAndWait({ prompt: "Continue ordinary work after reloading." }, 20_000);
    assert.equal((observed.at(-1)?.all.match(/Synthetic refreshed role marker/g) ?? []).length, 1);
    assert.equal((observed.at(-1)?.all.match(/Synthetic shared refresh marker/g) ?? []).length, 1);
    await other.sendAndWait({ prompt: "Handle this ordinary task in your own role." }, 20_000);
    assert.match(observed.at(-1)?.all ?? "", /Synthetic other role marker/);
    assert.match(observed.at(-1)?.all ?? "", /Synthetic shared refresh marker/);
    assert.doesNotMatch(observed.at(-1)?.all ?? "", /Synthetic refreshed role marker/);
    assert.equal(f.provider.counts().requests, 6);
    assert.equal(f.provider.counts().failures, 0);
  } finally {
    release();
    await working?.catch(() => {});
    await f.close();
  }
});
