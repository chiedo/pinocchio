import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { broadcastStatus } from "../src/broadcast.js";
import { upgradeBroadcast } from "../src/broadcast-cli.js";
import { EXTENSION_SEARCH_TOOL } from "../src/memory-protocol.js";
import {
  createBroadcastFixture,
  sessionChat,
  sessionWarnings,
} from "./support/broadcast-fixture.js";

test("refreshed startup, extension reload, and agent selection stay silent and scoped", {
  timeout: 120_000,
}, async () => {
  const observed: { all: string; latest: string }[] = [];
  const f = await createBroadcastFixture({
    observeRequest(messages) {
      observed.push({
        all: JSON.stringify(messages),
        latest: JSON.stringify(
          messages.findLast((message) => message.role === "user") ?? {},
        ),
      });
    },
  });
  try {
    await writeFile(
      f.profile,
      (await readFile(f.profile, "utf8")).replace(
        "Synthetic original role marker.",
        "Synthetic refreshed role marker.",
      ),
    );
    await writeFile(
      f.shared,
      `${await readFile(f.shared, "utf8")}\nSynthetic shared refresh marker.\n`,
    );
    await upgradeBroadcast(f.config);

    const [session, other] = await Promise.all([
      f.openSession(),
      f.openSession(undefined, "other-agent"),
    ]);
    await f.waitFor((status) => status.sessions.length === 2 &&
      status.sessions.every((item) => item.status === "updated"));
    assert.deepEqual(await sessionChat(session), []);
    assert.deepEqual(await sessionChat(other), []);
    assert.equal(f.provider.counts().requests, 0);
    assert.ok((await broadcastStatus(f.config)).sessions
      .filter((item) => item.agent === "broadcast-agent")
      .every((item) =>
        item.unmatchedTools?.includes("web_search") &&
        item.unmatchedTools.includes("exec") &&
        item.missingTools === undefined &&
        item.code === undefined));

    assert.deepEqual(await sessionWarnings(session), []);
    await session.sendAndWait({
      prompt: "Continue the ordinary task, without changing any files.",
    }, 20_000);
    let search = await session.rpc.tools.execute({
      name: EXTENSION_SEARCH_TOOL,
      arguments: { query: "Synthetic shared refresh marker" },
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
    assert.equal(search.resultType, "success", JSON.stringify(search));
    assert.deepEqual(
      JSON.parse(search.textResultForLlm).snippets,
      [],
      "Instructions must not be captured as memories",
    );
    assert.match(observed.at(-1)?.all ?? "", /Synthetic refreshed role marker/);
    assert.match(observed.at(-1)?.all ?? "", /Synthetic shared refresh marker/);
    assert.doesNotMatch(
      observed.at(-1)?.all ?? "",
      /Synthetic original role marker/,
    );

    const chatCounts = await Promise.all(
      f.sessions.map(async (item) => (await sessionChat(item)).length),
    );
    await upgradeBroadcast(f.config);
    await f.waitFor((status) => status.sessions.length === 2 &&
      status.sessions.every((item) => item.status === "updated"));
    await session.rpc.extensions.reload();
    await session.rpc.agent.select({ name: "broadcast-agent" });
    await session.rpc.tools.initializeAndValidate();
    await f.waitFor((status) => status.sessions.length === 2 &&
      status.sessions.every((item) => item.status === "updated"));
    await session.rpc.agent.select({ name: "other-agent" });
    await session.rpc.tools.initializeAndValidate();
    await f.waitFor((status) => status.sessions.some((item) =>
      item.sessionId === session.sessionId &&
      item.agent === "other-agent" &&
      item.status === "updated"));
    await session.rpc.agent.deselect();
    await f.waitFor((status) => status.sessions.length === 1);
    await session.rpc.agent.select({ name: "broadcast-agent" });
    await session.rpc.tools.initializeAndValidate();
    await f.waitFor((status) => status.sessions.length === 2 &&
      status.sessions.every((item) => item.status === "updated"));
    assert.deepEqual(
      await Promise.all(
        f.sessions.map(async (item) => (await sessionChat(item)).length),
      ),
      chatCounts,
    );
    assert.equal(f.provider.counts().requests, 1);

    await session.sendAndWait({
      prompt: "Continue ordinary work after reloading.",
    }, 20_000);
    assert.equal(
      (observed.at(-1)?.all.match(/Synthetic refreshed role marker/g) ?? [])
        .length,
      1,
    );
    assert.equal(
      (observed.at(-1)?.all.match(/Synthetic shared refresh marker/g) ?? [])
        .length,
      1,
    );
    await other.sendAndWait({
      prompt: "Handle this ordinary task in your own role.",
    }, 20_000);
    assert.match(observed.at(-1)?.all ?? "", /Synthetic other role marker/);
    assert.match(observed.at(-1)?.all ?? "", /Synthetic shared refresh marker/);
    assert.doesNotMatch(
      observed.at(-1)?.all ?? "",
      /Synthetic refreshed role marker/,
    );
    assert.equal(f.provider.counts().requests, 3);
    assert.equal(f.provider.counts().failures, 0);
  } finally {
    await f.close();
  }
});
