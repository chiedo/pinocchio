import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { approveAll, CopilotClient, RuntimeConnection, ToolSet } from "@github/copilot-sdk";
import type { CopilotSession, SessionConfig } from "@github/copilot-sdk";
import { registerBinding } from "../src/binding-registry.js";
import { enroll } from "../src/enrollment.js";
import { memoryLaunch } from "../src/memory-mcp.js";
import { SEARCH_TOOL, SAVE_TOOL } from "../src/memory-protocol.js";
import { isRecord } from "../src/identity.js";
import { createProductionFixture } from "./support/production-fixture.js";
import { startSyntheticProvider } from "./support/provider.js";

test("enrolled native profiles recall independently through the production context extension", { timeout: 180_000 }, async () => {
  const f = await createProductionFixture();
  const launches = new Map<string, ReturnType<typeof memoryLaunch>>();
  const observations: { status: unknown; snippets?: unknown; operationId?: unknown; code?: unknown }[] = [];
  const cases: string[] = [];
  const selectName = (messages: Record<string, unknown>[]) => {
    const prompt = String(messages.findLast((message) => message.role === "user")?.content ?? "");
    return { name: prompt.includes("HELPER") ? "memory-helper" : "memory-foreground", save: prompt.includes("SAVE") };
  };
  const provider = await startSyntheticProvider({
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
  function observe(session: CopilotSession) {
    return session.on("tool.execution_complete", (event) => {
      const text = event.data.result?.content;
      if (typeof text !== "string" || !text.includes('"status"')) return;
      try {
        const value: unknown = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        if (isRecord(value)) observations.push({ status: value.status, snippets: value.snippets,
          operationId: value.operationId, code: value.code });
      } catch { /* Non-memory built-in results are not part of this gate. */ }
    });
  }
  async function own(session: CopilotSession, prompt: string, expected: string) {
    const before = observations.length;
    await session.sendAndWait({ prompt }, 20_000);
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
      launches.set(name, memoryLaunch(reference));
      assert.match(await readFile(path, "utf8"), /model: synthetic-model/);
    }
    const config: SessionConfig = {
      workingDirectory: f.repository, configDirectory: f.config, enableConfigDiscovery: true,
      requestExtensions: true, enableExperimentalMode: true, enableManagedSettings: false,
      extensionSdkPath: fileURLToPath(new URL(".", import.meta.resolve("@github/copilot-sdk"))),
      model: "synthetic-model", provider: { type: "openai", baseUrl: provider.baseUrl, wireApi: "completions" },
      availableTools: new ToolSet().addMcp("*").addBuiltIn(["view", "task"]),
      agent: "memory-foreground", onPermissionRequest: approveAll, infiniteSessions: { enabled: false },
    };
    await client.start();
    assert.equal((await client.getStatus()).version, "1.0.83");
    let session = await client.createSession(config);
    let stop = observe(session);
    await session.rpc.tools.initializeAndValidate();
    await own(session, "FOREGROUND SAVE synthetic work.", "committed");
    cases.push("foreground-save");
    const recalled = await own(session, "FOREGROUND SEARCH prior synthetic work.", "ok");
    assert.match(JSON.stringify(recalled.snippets), /memory-foreground/);
    assert.doesNotMatch(JSON.stringify(recalled.snippets), /memory-helper/);
    cases.push("foreground-recall");
    await session.rpc.tools.execute({ name: "task", arguments: {
      agent_type: "memory-helper", name: "synthetic-helper", description: "Save helper memory",
      prompt: "HELPER SAVE synthetic work.", mode: "sync",
    } });
    assert.ok(observations.some((item) => item.operationId === "save-memory-helper" && item.status === "committed"),
      JSON.stringify(observations.map((item) => ({ status: item.status, code: item.code }))));
    cases.push("helper-save");
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
    await session.rpc.extensions.reload();
    await session.rpc.tools.initializeAndValidate();
    await own(session, "FOREGROUND SEARCH after extension reload.", "ok");
    cases.push("extension-reload");
    const sessionId = session.sessionId;
    stop();
    await client.stop();
    client = createClient();
    await client.start();
    session = await client.resumeSession(sessionId, config);
    stop = observe(session);
    await session.rpc.tools.initializeAndValidate();
    await own(session, "FOREGROUND SEARCH after cold resume.", "ok");
    cases.push("cold-resume");
    stop();
    assert.equal(provider.counts().failures, 0);
    passed = true;
  } finally {
    await client.stop();
    await provider.close();
    await f.close();
    await mkdir("test-results", { recursive: true });
    await writeFile("test-results/memory-workflow.json", JSON.stringify({
      gate: "production-keyword-memory", passed, cases, baseline: "CLI 1.0.83 / Linux x64",
    }, null, 2) + "\n");
  }
});
