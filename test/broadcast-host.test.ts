import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { upgradeBroadcast } from "../src/broadcast-cli.js";
import {
  createBroadcastFixture,
  sessionChat as chat,
} from "./support/broadcast-fixture.js";

test("native refresh is silent across startup and ongoing work", {
  timeout: 120_000,
}, async () => {
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
    assert.equal(f.provider.counts().failures, 0);
  } finally {
    release();
    await working?.catch(() => {});
    await f.close();
  }
});
