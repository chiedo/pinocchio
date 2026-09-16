import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import { setup } from "../src/setup-cli.js";
import { bindingForDefinition, revokeBinding } from "../src/binding-registry.js";
import {
  BroadcastListener, BROADCAST_LIVE_MS, broadcastRuntimeVersion, broadcastSnapshot,
  broadcastStatus, latestBroadcast, publishBroadcast, withBroadcastLock,
} from "../src/broadcast.js";
import type { BroadcastRequest } from "../src/broadcast.js";
import { main, upgradeBroadcast } from "../src/broadcast-cli.js";
import { MANAGED_AGENT_TOOLS } from "../src/enrollment.js";

async function fixture(tools?: string) {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-broadcast-"));
  const options = { configRoot: root, name: "first", global: true, ...(tools ? { tools } : {}) };
  try {
    await setup(options);
    const profile = join(root, "agents", "first.agent.md");
    const found = await bindingForDefinition(root, profile);
    assert.ok(found);
    const reference = found;
    const runtime = await broadcastRuntimeVersion();
    const listener = new BroadcastListener(root, "session-one", runtime);
    await listener.heartbeat(reference);
    async function request(overrides: Partial<BroadcastRequest> = {}) {
      const snapshot = await broadcastSnapshot(reference);
      const value: BroadcastRequest = {
        version: 1, id: randomUUID(), createdAt: Date.now(), runtime,
        targets: [snapshot.target], agents: [{ bindingId: reference.bindingId, agent: "first", status: "refreshed" }],
        ...overrides,
      };
      await publishBroadcast(root, value);
      return value;
    }
    return { root, options, profile, reference, runtime, listener, request };
  } catch (error) { await rm(root, { recursive: true }); throw error; }
}

test("broadcast refresh preserves enrollment and requires delivery completion before updated", async () => {
  const f = await fixture();
  try {
    const receipt = await readFile(join(f.root, "pinocchio", "setup", "first.json"), "utf8");
    await writeFile(f.profile, (await readFile(f.profile, "utf8")) + "\nUse short answers.\n");
    const result = await upgradeBroadcast(f.root);
    assert.equal(result.agents[0]?.status, "refreshed");
    assert.equal(result.sessions[0]?.status, "pending");
    assert.equal(await readFile(join(f.root, "pinocchio", "setup", "first.json"), "utf8"), receipt);
    const request = await latestBroadcast(f.root);
    assert.ok(request);
    const prompt = await f.listener.prepare(f.reference, request.targets[0]!.tools);
    assert.match(prompt ?? "", /Use short answers/);
    assert.match(prompt ?? "", /Continue the user's actual request normally/);
    assert.doesNotMatch(prompt ?? "", /Acknowledge receipt|Do not call tools|Pinocchio broadcast [0-9a-f-]{36}/);
    assert.equal((await broadcastStatus(f.root)).sessions[0]?.status, "pending");
    await f.listener.acknowledge(f.reference);
    assert.equal((await broadcastStatus(f.root)).sessions[0]?.status, "updated");
    assert.equal(await f.listener.prepare(f.reference, request.targets[0]!.tools), undefined);
    const saved = await readFile(join(f.root, "pinocchio", "broadcast", "latest.json"), "utf8");
    assert.doesNotMatch(saved, /Use short answers/);
    await f.listener.close();
    assert.deepEqual((await broadcastStatus(f.root)).sessions, []);
  } finally { await rm(f.root, { recursive: true }); }
});

test("identical broadcasts replace the prompt with identical instructions rather than stacking them", async () => {
  const f = await fixture();
  try {
    const first = await f.request();
    const prompt = await f.listener.prepare(f.reference, first.targets[0]!.tools);
    assert.ok(prompt);
    await f.listener.acknowledge(f.reference);
    const second = await f.request();
    assert.notEqual(first.id, second.id);
    assert.equal(await f.listener.prepare(f.reference, second.targets[0]!.tools), prompt);
    assert.equal((await broadcastStatus(f.root)).sessions[0]?.status, "pending");
    await f.listener.acknowledge(f.reference);
    const updated = (await broadcastStatus(f.root)).sessions[0];
    assert.equal(updated?.requestId, second.id);
    assert.equal(updated?.status, "updated");
    assert.equal(f.listener.issue(), undefined);
    await writeFile(join(f.root, "pinocchio", "AGENTS.md"), "A genuinely new shared rule.\n");
    const third = await f.request();
    assert.match(await f.listener.prepare(f.reference, third.targets[0]!.tools) ?? "", /A genuinely new shared rule/);
    assert.equal((await broadcastStatus(f.root)).sessions[0]?.status, "pending");
    await f.listener.acknowledge(f.reference);
    assert.equal((await broadcastStatus(f.root)).sessions[0]?.status, "updated");
  } finally { await rm(f.root, { recursive: true }); }
});

test("failed host delivery never reports updated or repeatedly retries the same request", async () => {
  const f = await fixture();
  try {
    const first = await f.request();
    assert.ok(await f.listener.prepare(f.reference, first.targets[0]!.tools));
    await f.listener.failed(new Error("Synthetic host failure"));
    const issue = f.listener.issue();
    assert.equal(issue?.code, "BROADCAST_FAILED");
    assert.equal(issue?.restartRequired, false);
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(await f.listener.prepare(f.reference, first.targets[0]!.tools), undefined);
      assert.deepEqual(f.listener.issue(), issue);
      assert.equal((await broadcastStatus(f.root)).sessions[0]?.status, "failed");
    }
    await assert.rejects(f.listener.acknowledge(f.reference), { code: "BROADCAST_NO_DELIVERY" });
    const retry = await f.request();
    assert.ok(await f.listener.prepare(f.reference, retry.targets[0]!.tools));
    await f.listener.acknowledge(f.reference);
    assert.equal(f.listener.issue(), undefined);
    await f.listener.failed(Object.assign(new Error("Synthetic host reset"), { code: "BROADCAST_FAILED" }));
    const recovery = await f.request();
    assert.ok(await f.listener.prepare(f.reference, recovery.targets[0]!.tools));
    assert.equal((await broadcastStatus(f.root)).sessions[0]?.status, "pending", "A retry must wait for host acknowledgment");
    await f.listener.acknowledge(f.reference);
    assert.equal(f.listener.issue(), undefined);
  } finally { await rm(f.root, { recursive: true }); }
});

test("runtime and settings changes still require a restart, never updated", async (t) => {
  for (const reason of ["RUNTIME_CHANGED", "AGENT_SETTINGS_CHANGED"]) {
    await t.test(reason, async () => {
      const f = await fixture();
      try {
        if (reason === "AGENT_SETTINGS_CHANGED") {
          await writeFile(f.profile, (await readFile(f.profile, "utf8")).replace("tools:", "model: changed-model\ntools:"));
        }
        const request = await f.request(reason === "RUNTIME_CHANGED" ? { runtime: "a".repeat(64) } : {});
        assert.equal(await f.listener.prepare(f.reference, request.targets[0]!.tools), undefined);
        const record = (await broadcastStatus(f.root)).sessions[0];
        assert.equal(record?.status, "restart-required");
        assert.equal(record?.code, reason);
        await assert.rejects(f.listener.acknowledge(f.reference), { code: "BROADCAST_NO_DELIVERY" });
      } finally { await rm(f.root, { recursive: true }); }
    });
  }
});

test("unmatched allowlist entries do not block delivery or modify agent permissions", async () => {
  const f = await fixture("view,web_search,exec");
  try {
    const original = await readFile(f.profile, "utf8");
    const request = await f.request();
    assert.deepEqual(request.targets[0]!.tools, ["view", "web_search", "exec", ...MANAGED_AGENT_TOOLS]);
    const prompt = await f.listener.prepare(f.reference, ["view", ...MANAGED_AGENT_TOOLS]);
    assert.ok(prompt);
    const pending = (await broadcastStatus(f.root)).sessions[0];
    assert.equal(pending?.status, "pending");
    assert.deepEqual(pending?.unmatchedTools, ["web_search", "exec"]);
    assert.equal(pending?.missingTools, undefined);
    await f.listener.acknowledge(f.reference);
    const updated = (await broadcastStatus(f.root)).sessions[0];
    assert.equal(updated?.status, "updated");
    assert.equal(updated?.code, undefined);
    assert.deepEqual(updated?.unmatchedTools, ["web_search", "exec"]);
    assert.equal(await readFile(f.profile, "utf8"), original);
  } finally { await rm(f.root, { recursive: true }); }
});

test("missing managed tools fail explicitly and recover on the same broadcast when tools load", async () => {
  const f = await fixture();
  try {
    for (const missing of MANAGED_AGENT_TOOLS) {
      const request = await f.request();
      const tools = request.targets[0]!.tools;
      const incomplete = tools.filter((tool) => tool !== missing);
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal(await f.listener.prepare(f.reference, incomplete), undefined);
        const failed = (await broadcastStatus(f.root)).sessions[0];
        assert.equal(failed?.status, "failed");
        assert.equal(failed?.code, "TOOLS_NOT_AVAILABLE");
        assert.deepEqual(failed?.missingTools, [missing]);
        await assert.rejects(f.listener.acknowledge(f.reference), { code: "BROADCAST_NO_DELIVERY" });
      }
      assert.ok(await f.listener.prepare(f.reference, tools));
      await f.listener.acknowledge(f.reference);
      const updated = (await broadcastStatus(f.root)).sessions[0];
      assert.equal(updated?.requestId, request.id);
      assert.equal(updated?.status, "updated");
      assert.equal(updated?.code, undefined);
      assert.equal(updated?.missingTools, undefined);
      assert.equal(await f.listener.prepare(f.reference, tools), undefined);
    }
  } finally { await rm(f.root, { recursive: true }); }
});

test("new broadcasts clear previous tool diagnostics while delivery is pending", async () => {
  const f = await fixture("view,web_search");
  try {
    await f.request();
    assert.equal(await f.listener.prepare(f.reference, []), undefined);
    const failed = (await broadcastStatus(f.root)).sessions[0];
    assert.deepEqual(failed?.missingTools, [...MANAGED_AGENT_TOOLS]);
    assert.deepEqual(failed?.unmatchedTools, ["view", "web_search"]);
    const request = await f.request();
    const pending = (await broadcastStatus(f.root)).sessions[0];
    assert.equal(pending?.requestId, request.id);
    assert.equal(pending?.status, "pending");
    assert.equal(pending?.code, undefined);
    assert.equal(pending?.missingTools, undefined);
    assert.equal(pending?.unmatchedTools, undefined);
  } finally { await rm(f.root, { recursive: true }); }
});

test("independent listeners acknowledge independently and exclude expired heartbeats", async () => {
  const f = await fixture();
  try {
    const second = new BroadcastListener(f.root, "session-two", f.runtime);
    await second.heartbeat(f.reference);
    const request = await f.request();
    await f.listener.prepare(f.reference, request.targets[0]!.tools);
    await f.listener.acknowledge(f.reference);
    assert.deepEqual((await broadcastStatus(f.root)).sessions.map((item) => item.status).sort(), ["pending", "updated"]);
    await second.prepare(f.reference, request.targets[0]!.tools);
    await second.acknowledge(f.reference);
    assert.ok((await broadcastStatus(f.root)).sessions.every((item) => item.status === "updated"));
    assert.deepEqual((await broadcastStatus(f.root, Date.now() + BROADCAST_LIVE_MS + 1)).sessions, []);
    await f.request();
    assert.ok((await broadcastStatus(f.root)).sessions.every((item) => item.status === "pending"));
  } finally { await rm(f.root, { recursive: true }); }
});

test("changed snapshots, revoked bindings, and switched agents cannot be acknowledged", async () => {
  const f = await fixture();
  try {
    let request = await f.request();
    await f.listener.prepare(f.reference, request.targets[0]!.tools);
    await writeFile(join(f.root, "pinocchio", "AGENTS.md"), "New shared rules\n");
    await assert.rejects(f.listener.acknowledge(f.reference), { code: "BROADCAST_TARGET_CHANGED" });
    request = await f.request();
    await f.listener.prepare(f.reference, request.targets[0]!.tools);
    await setup({ configRoot: f.root, name: "second", global: true });
    const second = await bindingForDefinition(f.root, join(f.root, "agents", "second.agent.md"));
    assert.ok(second);
    await f.listener.heartbeat(second);
    await assert.rejects(f.listener.acknowledge(f.reference), { code: "BROADCAST_NO_DELIVERY" });
    await f.listener.heartbeat(f.reference);
    await f.listener.prepare(f.reference, request.targets[0]!.tools);
    await revokeBinding(f.reference);
    await assert.rejects(f.listener.acknowledge(f.reference), { code: "REVOKED_BINDING" });
  } finally { await rm(f.root, { recursive: true }); }
});

test("broadcast excludes removed agents and reports partial refresh failures", async () => {
  const f = await fixture();
  try {
    await setup({ configRoot: f.root, name: "second", global: true });
    const second = join(f.root, "agents", "second.agent.md");
    await writeFile(second, (await readFile(second, "utf8")).replace("<!-- /pinocchio-memory:v1 -->", ""));
    const result = await upgradeBroadcast(f.root);
    assert.equal(result.agents.find((agent) => agent.agent === "first")?.status, "refreshed");
    assert.equal(result.agents.find((agent) => agent.agent === "second")?.code, "MANAGED_BLOCK_CHANGED");
    await setup({ ...f.options, remove: true });
    assert.equal((await upgradeBroadcast(f.root)).agents.some((agent) => agent.agent === "first"), false);
  } finally { await rm(f.root, { recursive: true }); }
});

test("broadcast restores missing managed tools even when the instruction block is current", async () => {
  const f = await fixture();
  try {
    const original = await readFile(f.profile, "utf8");
    const match = /^---\n([\s\S]*?)\n---\n/.exec(original);
    assert.ok(match);
    const doc = parseDocument(match[1]!);
    doc.set("tools", (await broadcastSnapshot(f.reference)).target.tools.filter((tool) => tool !== "pinocchio_jobs"));
    await writeFile(f.profile, `---\n${String(doc)}---\n${original.slice(match[0].length)}`);
    assert.equal((await broadcastSnapshot(f.reference)).target.tools.includes("pinocchio_jobs"), false);
    const result = await upgradeBroadcast(f.root);
    assert.equal(result.agents[0]?.status, "refreshed");
    assert.ok((await broadcastSnapshot(f.reference)).target.tools.includes("pinocchio_jobs"));
  } finally { await rm(f.root, { recursive: true }); }
});

test("broadcast rejects concurrent publishers, invalid commands and unsafe state", async () => {
  const f = await fixture();
  try {
    await withBroadcastLock(f.root, async () => {
      await assert.rejects(upgradeBroadcast(f.root), { code: "BROADCAST_BUSY" });
    });
    await assert.rejects(main(["erase"]), { code: "INVALID_ARGUMENTS" });
    const path = join(f.root, "pinocchio", "broadcast", "latest.json");
    const target = join(f.root, "unrelated.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(latestBroadcast(f.root));
    assert.equal(await readFile(target, "utf8"), "{}\n");
  } finally { await rm(f.root, { recursive: true }); }
});
