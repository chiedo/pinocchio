import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  BROADCAST_HEARTBEAT_MS,
  latestBroadcast,
  publishBroadcast,
} from "../src/broadcast.js";
import { upgradeBroadcast } from "../src/broadcast-cli.js";
import {
  createBroadcastFixture,
  sessionChat,
  sessionWarnings,
} from "./support/broadcast-fixture.js";

test("unrecoverable runtime reloads show one actionable warning without model turns", {
  timeout: 90_000,
}, async () => {
  const f = await createBroadcastFixture({}, false, false);
  try {
    const session = await f.openSession();
    await f.waitFor((status) => status.sessions.length === 1);
    await upgradeBroadcast(f.config);
    await f.waitFor((status) => status.sessions[0]?.status === "updated");
    const original = (await session.rpc.agent.getCurrent()).agent;
    const request = await latestBroadcast(f.config);
    assert.ok(request);
    await publishBroadcast(f.config, {
      ...request,
      id: randomUUID(),
      runtime: "a".repeat(64),
    });
    await f.waitFor((status) => status.sessions.some((item) =>
      item.status === "restart-required" &&
      item.code === "RUNTIME_RELOAD_FAILED"));
    await new Promise((resolve) =>
      setTimeout(resolve, 2 * BROADCAST_HEARTBEAT_MS + 500));
    const notices = await sessionWarnings(session);
    assert.equal(notices.length, 1);
    assert.match(JSON.stringify(notices), /needs a session restart/);
    assert.match(JSON.stringify(notices), /npm run broadcast -- status/);
    assert.deepEqual((await session.rpc.agent.getCurrent()).agent, original);
    assert.deepEqual(await sessionChat(session), []);
    assert.equal(f.provider.counts().requests, 0);
  } finally {
    await f.close();
  }
});
