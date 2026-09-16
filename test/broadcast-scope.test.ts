import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import test from "node:test";
import { broadcastStatus } from "../src/broadcast.js";
import { upgradeBroadcast } from "../src/broadcast-cli.js";
import {
  createBroadcastFixture,
  sessionChat,
} from "./support/broadcast-fixture.js";

test("a repository-scoped refresh cannot change instructions outside its bound repository", {
  timeout: 60_000,
}, async () => {
  let observed = "";
  const f = await createBroadcastFixture({
    observeRequest(messages) {
      observed = JSON.stringify(messages);
    },
  }, true, false);
  try {
    const session = await f.openSession(
      await realpath(f.workspace.otherRepository),
    );
    await f.waitFor((status) => status.sessions.length === 1);
    const original = (await session.rpc.agent.getCurrent()).agent;
    await writeFile(f.shared, "Synthetic repository-only refresh marker.\n");
    await upgradeBroadcast(f.config);
    await f.waitFor((status) => status.sessions[0]?.status === "failed");
    assert.equal(
      (await broadcastStatus(f.config)).sessions[0]?.code,
      "BROADCAST_SCOPE_MISMATCH",
    );
    assert.deepEqual((await session.rpc.agent.getCurrent()).agent, original);
    assert.deepEqual(await sessionChat(session), []);
    assert.equal(f.provider.counts().requests, 0);
    await session.sendAndWait({
      prompt: "Continue ordinary work here.",
    }, 20_000);
    assert.doesNotMatch(observed, /Synthetic repository-only refresh marker/);
  } finally {
    await f.close();
  }
});
