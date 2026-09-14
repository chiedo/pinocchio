import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { approveAll, CopilotClient, RuntimeConnection, ToolSet } from "@github/copilot-sdk";
import type { CopilotSession, SessionConfig } from "@github/copilot-sdk";
import { registerBinding } from "../src/binding-registry.js";
import { enroll } from "../src/enrollment.js";
import { setConversationEnabled } from "../src/conversation-memory.js";
import { memoryLaunch } from "../src/memory-mcp.js";
import { SEARCH_TOOL, SAVE_TOOL } from "../src/memory-protocol.js";
import { isRecord } from "../src/identity.js";
import { createProductionFixture } from "./support/production-fixture.js";
import { startSyntheticProvider } from "./support/provider.js";
import { acceptance } from "../src/evaluation.js";

test("enrolled native profiles recall independently through the production context extension", { timeout: 180_000 }, async (t) => {
  const contract = await acceptance();
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const f = await createProductionFixture();
  const launches = new Map<string, ReturnType<typeof memoryLaunch>>();
  const observations: { status: unknown; snippets?: unknown; operationId?: unknown; code?: unknown; sessionRemaining?: unknown }[] = [];
  const cases: string[] = [];
  const lifecycle: string[] = [];
  const waiters = new Set<() => void>();
  const selectName = (messages: Record<string, unknown>[]) => {
    const prompt = String(messages.findLast((message) => message.role === "user")?.content ?? "");
    return { name: prompt.includes("HELPER") ? "memory-helper" : "memory-foreground", save: prompt.includes("SAVE") };
  };
  const provider = await startSyntheticProvider({
    replyWithoutTools: true,
    selectTool(messages) {
      const { name, save } = selectName(messages);
      const launch = launches.get(name);
      if (!launch) throw new Error("SYNTHETIC_TARGET_MISSING");
      return `${launch.serverName}-${save ? SAVE_TOOL : SEARCH_TOOL}`;
    },
    toolArguments(messages) {
      const { name, save } = selectName(messages);
      return save ? {
        action: "remember", operationId: `save-${name}`, note: {
          content: `synthetic prior work for ${name}`, kind: "fact",
          evidence: [{ kind: "manual_entry", reference: { type: "text", value: "invented public gate" } }],
        },
      } : { query: "synthetic" };
    },
  });
  const createClient = () => new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: fileURLToPath(new URL("../../node_modules/.bin/copilot", import.meta.url)),
    }), mode: "empty", workingDirectory: f.repository, baseDirectory: f.config,
    env: f.env, useLoggedInUser: false, logLevel: "none",
  });
  let client = createClient();
  let passed = false;
  let stage = "enrollment";
  function observe(session: CopilotSession) {
    return session.on("tool.execution_complete", (event) => {
      const text = event.data.result?.content;
      if (event.data.error) {
        observations.push({ status: "host_error", code: event.data.error.message.slice(0, 200) });
        for (const notify of waiters) notify();
      }
      if (typeof text !== "string" || !text.includes('"status"')) return;
      try {
        const value: unknown = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        if (isRecord(value)) observations.push({ status: value.status, snippets: value.snippets,
          operationId: value.operationId, code: value.code, sessionRemaining: value.sessionRemaining });
        for (const notify of waiters) notify();
      } catch { /* Non-memory built-in results are not part of this gate. */ }
    });
  }
  async function waitForResult(before: number, expected: string) {
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (observations.slice(before).some((item) => item.status === expected)) {
          clearTimeout(timer); waiters.delete(check); resolve();
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(JSON.stringify({ expected, observed: observations.slice(before).map((item) => ({ status: item.status, code: item.code })) })));
      }, 1_000);
      waiters.add(check); check();
    });
  }
  async function own(session: CopilotSession, prompt: string, expected: string) {
    stage = prompt.includes("SAVE") ? "foreground-save" : "foreground-search";
    const before = observations.length;
    await session.sendAndWait({ prompt }, 20_000);
    await waitForResult(before, expected);
    const result = observations.slice(before).find((item) => item.status === expected);
    assert.ok(result, JSON.stringify({ expected, observed: observations.slice(before) }));
    return result;
  }
  try {
    for (const name of ["memory-foreground", "memory-helper"]) {
      const root = name === "memory-foreground" ? join(f.repository, ".github", "agents") : join(f.config, "agents");
      await mkdir(root, { recursive: true });
      const path = join(root, `${name}.agent.md`);
      await writeFile(path, `---\nname: ${name}\ndescription: Synthetic memory workflow\ntools: [view${name === "memory-foreground" ? ", task" : ""}]\nmodel: synthetic-model\n---\nUse only your configured tools.\n`);
      const reference = await registerBinding({
        configRoot: f.config, definitionPath: path, origin: name === "memory-foreground" ? "project" : "user",
        originRoot: root, scope: { kind: "repository", root: f.repository },
      });
      await enroll(reference, true);
      // Keep explicit-tool assertions independent of automatic recall's shared budget.
      await setConversationEnabled(reference, false);
      launches.set(name, memoryLaunch(reference));
      assert.match(await readFile(path, "utf8"), /model: synthetic-model/);
    }
    const config: SessionConfig = {
      workingDirectory: f.repository, configDirectory: f.config, enableConfigDiscovery: true,
      requestExtensions: true, enableExperimentalMode: true, enableManagedSettings: false,
      extensionSdkPath: fileURLToPath(new URL(".", import.meta.resolve("@github/copilot-sdk"))),
      model: "synthetic-model", provider: { type: "openai", baseUrl: provider.baseUrl, wireApi: "completions" },
      availableTools: new ToolSet().addMcp("*").addBuiltIn(["view", "task"]),
      agent: "memory-foreground", onPermissionRequest: approveAll, infiniteSessions: { enabled: true },
      hooks: { onSessionStart(input) { lifecycle.push(input.source); } },
    };
    await client.start();
    assert.equal((await client.getStatus()).version, "1.0.83");
    stage = "create-session";
    let session = await client.createSession(config);
    let stop = observe(session);
    await session.rpc.tools.initializeAndValidate();
    await own(session, "FOREGROUND SAVE synthetic work.", "committed");
    cases.push("foreground-save");
    const recalled = await own(session, "FOREGROUND SEARCH prior synthetic work.", "ok");
    assert.match(JSON.stringify(recalled.snippets), /memory-foreground/);
    assert.doesNotMatch(JSON.stringify(recalled.snippets), /memory-helper/);
    cases.push("foreground-recall");
    stage = "helper-save";
    await session.rpc.tools.execute({ name: "task", arguments: {
      agent_type: "memory-helper", name: "synthetic-helper", description: "Save helper memory",
      prompt: "HELPER SAVE synthetic work.", mode: "sync",
    } });
    assert.ok(observations.some((item) => item.operationId === "save-memory-helper" && item.status === "committed"),
      JSON.stringify(observations.map((item) => ({ status: item.status, code: item.code }))));
    cases.push("helper-save");
    stage = "helper-recall";
    const before = observations.length;
    await session.rpc.tools.execute({ name: "task", arguments: {
      agent_type: "memory-helper", name: "synthetic-helper-new-instance", description: "Recall helper memory",
      prompt: "HELPER SEARCH prior synthetic work.", mode: "sync",
    } });
    const helper = observations.slice(before).find((item) => item.status === "ok");
    assert.ok(helper);
    assert.match(JSON.stringify(helper.snippets), /memory-helper/);
    assert.doesNotMatch(JSON.stringify(helper.snippets), /memory-foreground/);
    cases.push("new-helper-instance-recall");
    const foreign = launches.get("memory-helper");
    assert.ok(foreign);
    const denied = await session.rpc.tools.execute({
      name: `${foreign.serverName}-${SEARCH_TOOL}`, arguments: { query: "synthetic" },
    });
    assert.ok(typeof denied !== "string" && denied.resultType !== "success");
    cases.push("cross-agent-denied");
    const beforeCompaction = await own(session, "FOREGROUND SEARCH before compaction.", "ok");
    stage = "native-compaction";
    const compaction = await session.rpc.history.compact({ trigger: "manual" });
    assert.equal(compaction.success, true);
    assert.ok(compaction.messagesRemoved > 0);
    assert.ok(compaction.summaryContent);
    const compacted = await own(session, "FOREGROUND SEARCH after compaction.", "ok");
    assert.ok(Number(compacted.sessionRemaining) < Number(beforeCompaction.sessionRemaining));
    cases.push("native-compaction-preserves-accounting");
    stage = "extension-reload";
    await session.rpc.extensions.reload();
    const { extensions } = await session.rpc.extensions.list();
    assert.ok(extensions.some((extension) => extension.name === "pinocchio-memory" && extension.status === "running"),
      JSON.stringify(extensions.map((extension) => ({ name: extension.name, status: extension.status }))));
    await session.rpc.agent.select({ name: "memory-foreground" });
    await session.rpc.tools.initializeAndValidate();
    const reloaded = await own(session, "FOREGROUND SEARCH after extension reload.", "ok");
    assert.ok(Number(reloaded.sessionRemaining) < Number(recalled.sessionRemaining));
    cases.push("extension-reload");
    const sessionId = session.sessionId;
    stop();
    await client.stop();
    client = createClient();
    await client.start();
    stage = "cold-resume";
    session = await client.resumeSession(sessionId, config);
    stop = observe(session);
    await session.rpc.extensions.reload();
    const resumed = await session.rpc.extensions.list();
    assert.ok(resumed.extensions.some((extension) => extension.name === "pinocchio-memory" && extension.status === "running"));
    await session.rpc.agent.select({ name: "memory-foreground" });
    await session.rpc.tools.initializeAndValidate();
    const cold = await own(session, "FOREGROUND SEARCH after cold resume.", "ok");
    assert.ok(Number(cold.sessionRemaining) < Number(reloaded.sessionRemaining));
    cases.push("cold-resume");
    assert.ok(lifecycle.includes("resume"));
    stop();
    session = await client.createSession(config);
    stop = observe(session);
    await session.rpc.tools.initializeAndValidate();
    const fresh = await own(session, "FOREGROUND SEARCH in a new root session.", "ok");
    assert.match(JSON.stringify(fresh.snippets), /memory-foreground/);
    assert.ok(Number(fresh.sessionRemaining) > Number(cold.sessionRemaining));
    cases.push("new-session-recall");
    stop();
    assert.equal(provider.counts().failures, 0);
    passed = true;
  } catch (error) {
    t.diagnostic(JSON.stringify({ gate: "memory-workflow", stage, cases, provider: provider.counts() }));
    throw error;
  } finally {
    const stopped = await Promise.allSettled([client.stop(), provider.close()]);
    const cleaned = await Promise.allSettled([f.close()]);
    await mkdir("test-results", { recursive: true });
    await writeFile("test-results/memory-workflow.json", JSON.stringify({
      gate: "production-keyword-memory", passed, stage, cases, lifecycle,
      contractHash: contract.hash, commit,
      baseline: "CLI 1.0.83 / Linux x64; SDK root hook capability enabled",
    }, null, 2) + "\n");
    if ([...stopped, ...cleaned].some((result) => result.status === "rejected")) {
      t.diagnostic("MEMORY_WORKFLOW_CLEANUP_FAILED");
      if (passed) throw new Error("MEMORY_WORKFLOW_CLEANUP_FAILED");
    }
  }
});
