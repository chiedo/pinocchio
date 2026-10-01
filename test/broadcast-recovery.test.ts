import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import {
  BROADCAST_HEARTBEAT_MS,
  latestBroadcast,
  publishBroadcast,
} from "../src/broadcast.js";
import { upgradeBroadcast } from "../src/broadcast-cli.js";
import { EXTENSION_SAVE_TOOL } from "../src/memory-protocol.js";
import { bindingForDefinition, loadBinding } from "../src/binding-registry.js";
import { MemoryStore } from "../src/memory-store.js";
import { offeredToolName } from "./support/provider.js";
import {
  createBroadcastFixture,
  sessionChat,
  sessionWarnings,
} from "./support/broadcast-fixture.js";

test("an already-running child keeps its own memory owner after an extension reload", {
  timeout: 90_000,
}, async () => {
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  const f = await createBroadcastFixture({
    textOnly: false,
    selectTool: (_messages, tools) => offeredToolName(tools, EXTENSION_SAVE_TOOL),
    toolArguments: (messages) => {
      const prompt = JSON.stringify(messages.findLast((message) => message.role === "user"));
      // Completion notifications can also prompt the foreground agent.
      if (!prompt?.includes("Save the synthetic-child-save memory operation and return.")) {
        return { action: "status", operationId: "synthetic-child-save" };
      }
      return {
        action: "remember", operationId: "synthetic-child-save",
        note: {
          content: "Synthetic child ownership after reload.", kind: "fact",
          evidence: [{ kind: "manual_entry", reference: { type: "text", value: "Synthetic regression fixture" } }],
        },
      };
    },
    async observeRequest() {
      markRequested();
      await requestGate;
    },
  });
  try {
    const session = await f.openSession(f.workspace.repository, "other-agent");
    const original = (await session.rpc.agent.getCurrent()).agent;
    const child = await session.rpc.tasks.startAgent({
      agentType: "broadcast-agent",
      name: "synthetic-memory-child",
      description: "Synthetic scoped memory recovery",
      prompt: "Save the synthetic-child-save memory operation and return.",
    });
    await requested;
    await session.rpc.extensions.reload();
    await session.rpc.tools.initializeAndValidate();
    releaseRequest();
    const deadline = Date.now() + 30_000;
    let events = await session.getEvents();
    const completed = () => events.filter((event) =>
      event.agentId === child.agentId && event.type === "tool.execution_complete");
    while (completed().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      events = await session.getEvents();
    }
    assert.ok(completed().length > 0, "CHILD_MEMORY_CALL_NOT_COMPLETED");
    assert.match(JSON.stringify(completed()), /committed/);
    assert.doesNotMatch(JSON.stringify(completed()), /MEMORY_OWNER_UNAVAILABLE|MEMORY_UNAVAILABLE/);
    assert.deepEqual((await session.rpc.agent.getCurrent()).agent, original);
    assert.equal(f.provider.counts().failures, 0);
    for (const name of ["broadcast-agent", "other-agent"]) {
      const reference = await bindingForDefinition(f.config, join(f.config, "agents", `${name}.agent.md`));
      assert.ok(reference);
      const binding = await loadBinding(reference);
      const store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: "global" });
      try {
        assert.equal((await store.operationStatus("synthetic-child-save")).status,
          name === "broadcast-agent" ? "committed" : "not_found");
      } finally { store.close(); }
    }
  } finally {
    releaseRequest();
    await f.close();
  }
});

test("stale runtime broadcasts explain republication without unnecessary reloads or model turns", {
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
      item.status === "failed" &&
      item.code === "BROADCAST_RUNTIME_STALE"));
    await new Promise((resolve) =>
      setTimeout(resolve, 2 * BROADCAST_HEARTBEAT_MS + 500));
    const notices = await sessionWarnings(session);
    assert.equal(notices.length, 1);
    assert.match(JSON.stringify(notices), /restarting will not fix this/);
    assert.match(JSON.stringify(notices), /npm run broadcast -- upgrade/);
    assert.match(JSON.stringify(notices), /npm run broadcast -- status/);
    assert.deepEqual((await session.rpc.agent.getCurrent()).agent, original);
    assert.deepEqual(await sessionChat(session), []);
    assert.equal(f.provider.counts().requests, 0);
    await upgradeBroadcast(f.config);
    await f.waitFor((status) => status.sessions[0]?.status === "updated");
  } finally {
    await f.close();
  }
});
