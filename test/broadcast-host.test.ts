import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { approveAll, CopilotClient, RuntimeConnection, ToolSet, type CopilotSession } from "@github/copilot-sdk";
import { setup } from "../src/setup-cli.js";
import { broadcastStatus, BROADCAST_HEARTBEAT_MS, latestBroadcast, publishBroadcast } from "../src/broadcast.js";
import { upgradeBroadcast } from "../src/broadcast-cli.js";
import { EXTENSION_SEARCH_TOOL } from "../src/memory-protocol.js";
import { createWorkspace } from "./support/workspace.js";
import { startSyntheticProvider, type SyntheticProviderOptions } from "./support/provider.js";

async function fixture(options: SyntheticProviderOptions = {}, scoped = false) {
  const workspace = await createWorkspace();
  const provider = await startSyntheticProvider({ textOnly: true, ...options });
  const config = await realpath(workspace.config);
  const repository = await realpath(workspace.repository);
  const clients: CopilotClient[] = [];
  const sessions: CopilotSession[] = [];
  async function close() {
    const disconnected = await Promise.allSettled(
      sessions.map((session) => session.disconnect()),
    );
    const stopped = await Promise.allSettled(
      clients.map((client) => client.stop()),
    );
    await provider.close();
    await workspace.close();
    assert.ok(
      disconnected.every((result) => result.status === "fulfilled"),
      "SESSION_CLEANUP_FAILED",
    );
    assert.ok(
      stopped.every((result) =>
        result.status === "fulfilled" && result.value.length === 0),
      "CLIENT_CLEANUP_FAILED",
    );
  }
  try {
    await rm(join(repository, ".github", "extensions", "pinocchio"), { recursive: true });
    await rm(join(workspace.otherRepository, ".github", "extensions", "pinocchio"), { recursive: true });
    await setup({
      configRoot: config, name: "broadcast-agent", tools: "view,web_search,exec",
      ...(scoped ? { repository } : { global: true }),
    });
    await setup({ configRoot: config, name: "other-agent", global: true });
    const otherProfile = join(config, "agents", "other-agent.agent.md");
    await writeFile(otherProfile, (await readFile(otherProfile, "utf8")) + "\nSynthetic other role marker.\n");
    const profile = join(config, "agents", "broadcast-agent.agent.md");
    const shared = join(config, "pinocchio", "AGENTS.md");
    await writeFile(profile, (await readFile(profile, "utf8")) + "\nSynthetic original role marker.\n");
    async function openSession(workingDirectory = repository, agent = "broadcast-agent") {
      const client = new CopilotClient({
        connection: RuntimeConnection.forStdio({
          path: fileURLToPath(new URL("../../node_modules/.bin/copilot", import.meta.url)),
        }),
        mode: "empty", workingDirectory, baseDirectory: config,
        env: workspace.env, useLoggedInUser: false, logLevel: "none",
      });
      clients.push(client);
      await client.start();
      const session = await client.createSession({
        workingDirectory, configDirectory: config,
        enableConfigDiscovery: true, requestExtensions: true,
        extensionSdkPath: fileURLToPath(new URL(".", import.meta.resolve("@github/copilot-sdk"))),
        enableExperimentalMode: true, enableManagedSettings: false,
        model: "synthetic-model",
        provider: { type: "openai", baseUrl: provider.baseUrl, wireApi: "completions" },
        availableTools: new ToolSet().addCustom("*").addBuiltIn("view"),
        agent, onPermissionRequest: approveAll, infiniteSessions: { enabled: false },
      });
      await session.rpc.tools.initializeAndValidate();
      sessions.push(session);
      return session;
    }
    async function waitFor(predicate: (status: Awaited<ReturnType<typeof broadcastStatus>>) => boolean) {
      const deadline = Date.now() + 30_000;
      let status = await broadcastStatus(config);
      while (!predicate(status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await broadcastStatus(config);
      }
      assert.ok(predicate(status), JSON.stringify(status));
    }
    return { workspace, config, profile, shared, provider, sessions, openSession, waitFor, close };
  } catch (error) { await close(); throw error; }
}

async function chat(session: CopilotSession) {
  return (await session.getEvents()).filter((event) => event.type === "user.message" || event.type === "assistant.message");
}

async function warnings(session: CopilotSession) {
  return (await session.getEvents()).filter((event) =>
    event.type === "session.warning" && event.data.message.startsWith("Pinocchio"));
}

test("native refresh is silent across startup, ongoing work, reload, and agent selection", { timeout: 240_000 }, async () => {
  const observed: { all: string; latest: string }[] = [];
  let release: () => void = () => {};
  let started: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture({
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
    await Promise.all(broadcastSessions.map(async (session) => {
      assert.deepEqual(await warnings(session), []);
      await session.sendAndWait({ prompt: "Continue the ordinary task, without changing any files." }, 20_000);
      const search = await session.rpc.tools.execute({
        name: EXTENSION_SEARCH_TOOL, arguments: { query: "Synthetic shared refresh marker" },
      });
      assert.notEqual(typeof search, "string");
      if (typeof search === "string") throw new Error("UNSTRUCTURED_SEARCH");
      assert.equal(search.resultType, "success");
      assert.deepEqual(JSON.parse(search.textResultForLlm).snippets, [], "Instructions must not be captured as memories");
    }));
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
    await f.waitFor((status) => status.sessions.some((item) => item.sessionId === restarted.sessionId && item.agent === "other-agent" && item.status === "updated"));
    await restarted.rpc.agent.deselect();
    await f.waitFor((status) => status.sessions.length === 3);
    await restarted.rpc.agent.select({ name: "broadcast-agent" });
    await f.waitFor((status) => status.sessions.length === 4 && status.sessions.every((item) => item.status === "updated"));
    assert.deepEqual(await Promise.all(f.sessions.map(async (session) => (await chat(session)).length)), chatCounts);
    assert.equal(f.provider.counts().requests, 4);
    await restarted.sendAndWait({ prompt: "Continue ordinary work after reloading." }, 20_000);
    assert.equal((observed.at(-1)?.all.match(/Synthetic refreshed role marker/g) ?? []).length, 1);
    assert.equal((observed.at(-1)?.all.match(/Synthetic shared refresh marker/g) ?? []).length, 1);
    await other.sendAndWait({ prompt: "Handle this ordinary task in your own role." }, 20_000);
    assert.match(observed.at(-1)?.latest ?? "", /Synthetic other role marker/);
    assert.match(observed.at(-1)?.latest ?? "", /Synthetic shared refresh marker/);
    assert.doesNotMatch(observed.at(-1)?.all ?? "", /Synthetic refreshed role marker/);
    assert.equal(f.provider.counts().requests, 6);
    assert.equal(f.provider.counts().failures, 0);
  } finally {
    release();
    await working?.catch(() => {});
    await f.close();
  }
});

test("unrecoverable runtime reloads show one actionable warning without model turns", { timeout: 90_000 }, async () => {
  const f = await fixture();
  try {
    const session = await f.openSession();
    await f.waitFor((status) => status.sessions.length === 1);
    await upgradeBroadcast(f.config);
    await f.waitFor((status) => status.sessions[0]?.status === "updated");
    const original = (await session.rpc.agent.getCurrent()).agent;
    const request = await latestBroadcast(f.config);
    assert.ok(request);
    await publishBroadcast(f.config, { ...request, id: randomUUID(), runtime: "a".repeat(64) });
    await f.waitFor((status) => status.sessions.some((item) =>
      item.status === "restart-required" && item.code === "RUNTIME_RELOAD_FAILED"));
    await new Promise((resolve) => setTimeout(resolve, 2 * BROADCAST_HEARTBEAT_MS + 500));
    const notices = await warnings(session);
    assert.equal(notices.length, 1);
    assert.match(JSON.stringify(notices), /needs a session restart/);
    assert.match(JSON.stringify(notices), /npm run broadcast -- status/);
    assert.deepEqual((await session.rpc.agent.getCurrent()).agent, original);
    assert.deepEqual(await chat(session), []);
    assert.equal(f.provider.counts().requests, 0);
    assert.equal(f.provider.counts().requests, 0);
  } finally { await f.close(); }
});

test("a repository-scoped refresh cannot change instructions outside its bound repository", { timeout: 60_000 }, async () => {
  let observed = "";
  const f = await fixture({ observeRequest(messages) { observed = JSON.stringify(messages); } }, true);
  try {
    const session = await f.openSession(await realpath(f.workspace.otherRepository));
    await f.waitFor((status) => status.sessions.length === 1);
    const original = (await session.rpc.agent.getCurrent()).agent;
    await writeFile(f.shared, "Synthetic repository-only refresh marker.\n");
    await upgradeBroadcast(f.config);
    await f.waitFor((status) => status.sessions[0]?.status === "failed");
    assert.equal((await broadcastStatus(f.config)).sessions[0]?.code, "BROADCAST_SCOPE_MISMATCH");
    assert.deepEqual((await session.rpc.agent.getCurrent()).agent, original);
    assert.deepEqual(await chat(session), []);
    assert.equal(f.provider.counts().requests, 0);
    await session.sendAndWait({ prompt: "Continue ordinary work here." }, 20_000);
    assert.doesNotMatch(observed, /Synthetic repository-only refresh marker/);
  } finally { await f.close(); }
});
