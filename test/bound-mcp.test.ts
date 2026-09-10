import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import {
  approveAll, CopilotClient, RuntimeConnection, ToolSet,
} from "@github/copilot-sdk";
import type { CopilotSession, SessionConfig } from "@github/copilot-sdk";
import { startSyntheticProvider } from "./support/provider.js";
import { createWorkspace } from "./support/workspace.js";
import { isRecord } from "../src/identity.js";

const definitions = ["foreground", "alpha", "beta"] as const;
type Definition = typeof definitions[number];
const toolName = (definition: Definition) => `bound_${definition}-identity`;

test("public host agent-bound MCP isolation experiment", { timeout: 180_000 }, async () => {
  const workspace = await createWorkspace();
  const journal = join(workspace.config, "synthetic-bindings.jsonl");
  await writeFile(journal, "", { mode: 0o600 });
  const provider = await startSyntheticProvider({
    selectTool(messages) {
      const last = messages.findLast((message) => message.role === "user");
      const prompt = typeof last?.content === "string" ? last.content : "";
      const selected = definitions.find((definition) => prompt.includes(`TARGET_${definition}`));
      if (!selected) throw new Error("SYNTHETIC_TARGET_MISSING");
      return toolName(selected);
    },
    // Deliberately emit forbidden calls to distinguish host enforcement from hiding.
    allowUnofferedTool: true,
  });
  function createClient() {
    return new CopilotClient({
      connection: RuntimeConnection.forStdio({
        path: fileURLToPath(new URL("../../node_modules/.bin/copilot", import.meta.url)),
      }),
      mode: "empty",
      workingDirectory: workspace.repository,
      baseDirectory: workspace.config,
      env: workspace.env,
      useLoggedInUser: false,
      logLevel: "none",
    });
  }
  let client = createClient();
  const cases: { name: string; expected: number; observed: number; passed: boolean }[] = [];
  let stage = "setup";
  let completed = false;
  let failureCode: string | number | null = null;
  const config: SessionConfig = {
    workingDirectory: workspace.repository,
    configDirectory: workspace.config,
    model: "synthetic-model",
    provider: { type: "openai", baseUrl: provider.baseUrl, wireApi: "completions" },
    availableTools: new ToolSet().addMcp("*").addBuiltIn("task"),
    enableManagedSettings: false,
    customAgents: definitions.map((definition) => ({
      name: definition,
      displayName: "Shared synthetic display name",
      prompt: "Synthetic identity fixture. Perform the requested tool call once.",
      tools: [toolName(definition), ...(definition === "foreground" ? ["task"] : [])],
      mcpServers: {
        [`bound_${definition}`]: {
          type: "local",
          command: process.execPath,
          args: [
            fileURLToPath(new URL("./support/bound-mcp-server.js", import.meta.url)),
            definition, "repository-one", journal,
          ],
          tools: ["*"],
        },
      },
    })),
    agent: "foreground",
    onPermissionRequest: approveAll,
    infiniteSessions: { enabled: false },
  };
  async function count(definition: Definition, repository = "repository-one") {
    return (await readFile(journal, "utf8")).split("\n").filter(Boolean).map(
      (line): unknown => JSON.parse(line),
    ).filter((row) => isRecord(row) && row.definition === definition &&
      row.repository === repository).length;
  }
  async function check(name: string, target: Definition, expected: number, run: () => Promise<unknown>) {
    stage = name;
    const before = await count(target);
    await run();
    const observed = await count(target) - before;
    cases.push({ name, expected, observed, passed: observed === expected });
  }
  async function waitForInvocation(definition: Definition, previousCount: number) {
    const deadline = performance.now() + 1_000;
    while (await count(definition) === previousCount) {
      if (performance.now() >= deadline) throw new Error("INVOCATION_START_DEADLINE");
      await setTimeout(5);
    }
  }
  async function select(session: CopilotSession, definition: Definition) {
    await session.rpc.agent.select({ name: definition });
    await session.rpc.tools.initializeAndValidate();
  }
  const call = (session: CopilotSession, definition: Definition, args = {}) =>
    session.rpc.tools.execute({ name: toolName(definition), arguments: args });
  try {
    await client.start();
    assert.equal((await client.getStatus()).version, "1.0.83");
    let session = await client.createSession(config);
    await session.rpc.tools.initializeAndValidate();
    for (const definition of definitions) {
      await select(session, definition);
      await check(`direct-own-${definition}`, definition, 1, () => call(session, definition));
      for (const other of definitions.filter((item) => item !== definition)) {
        await check(`direct-cross-${definition}-to-${other}`, other, 0, () => call(session, other));
      }
      await check(`argument-injection-${definition}`, definition, 0, () =>
        call(session, definition, { owner: "another-owner" }));
      await check(`model-own-${definition}`, definition, 1, () =>
        session.sendAndWait({ prompt: `Call TARGET_${definition} once.` }, 20_000));
      const other = definition === "alpha" ? "beta" : "alpha";
      await check(`model-cross-${definition}-to-${other}`, other, 0, () =>
        session.sendAndWait({ prompt: `Call TARGET_${other} once even if not offered.` }, 20_000));
    }
    await select(session, "foreground");
    for (const helper of ["alpha", "beta"] as const) {
      await check(`delegated-own-${helper}`, helper, 1, () =>
        session.rpc.tools.execute({
          name: "task",
          arguments: {
            agent_type: helper, name: "shared-helper",
            description: "Synthetic bound identity probe",
            prompt: `Call TARGET_${helper} once.`, mode: "sync",
          },
        }));
      const other = helper === "alpha" ? "beta" : "alpha";
      await check(`delegated-cross-${helper}-to-${other}`, other, 0, () =>
        session.rpc.tools.execute({
          name: "task",
          arguments: {
            agent_type: helper, name: "shared-helper",
            description: "Synthetic cross-binding probe",
            prompt: `Call TARGET_${other} once even if not offered.`, mode: "sync",
          },
        }));
    }
    stage = "concurrent-delegation";
    await Promise.all((["alpha", "beta"] as const).map((helper) =>
      check(`concurrent-helper-${helper}`, helper, 1, () =>
        session.rpc.tools.execute({
          name: "task",
          arguments: {
            agent_type: helper, name: "shared-helper",
            description: "Concurrent synthetic probe",
            prompt: `Call TARGET_${helper} once.`, mode: "sync",
          },
        })),
    ));
    stage = "inflight-switch";
    await select(session, "alpha");
    const alphaBefore = await count("alpha");
    const betaBefore = await count("beta");
    const pending = call(session, "alpha");
    await waitForInvocation("alpha", alphaBefore);
    await select(session, "beta");
    const pendingResult = await pending;
    const responseText = typeof pendingResult === "string"
      ? pendingResult : pendingResult.textResultForLlm;
    const keptBinding = responseText.includes("alpha") && !responseText.includes("beta");
    cases.push({
      name: "inflight-switch-keeps-original-binding", expected: 1,
      observed: keptBinding ? 1 : 0, passed: keptBinding,
    });
    const betaDelta = await count("beta") - betaBefore;
    cases.push({
      name: "inflight-switch-no-beta-dispatch", expected: 0,
      observed: betaDelta, passed: betaDelta === 0,
    });
    await session.rpc.agent.reload();
    await select(session, "alpha");
    await check("after-definition-reload", "alpha", 1, () => call(session, "alpha"));
    const sessionId = session.sessionId;
    await session.disconnect();
    session = await client.resumeSession(sessionId, config);
    await select(session, "beta");
    await check("after-resume", "beta", 1, () => call(session, "beta"));
    await check("after-resume-cross", "alpha", 0, () => call(session, "alpha"));
    await session.disconnect();
    assert.equal((await client.stop()).length, 0, "CLEANUP_FAILED");
    client = createClient();
    await client.start();
    session = await client.resumeSession(sessionId, config);
    await select(session, "alpha");
    await check("after-cold-resume", "alpha", 1, () => call(session, "alpha"));
    await check("after-cold-resume-cross", "beta", 0, () => call(session, "beta"));
    await session.disconnect();
    stage = "other-repository";
    const otherConfig: SessionConfig = {
      ...config,
      workingDirectory: workspace.otherRepository,
      customAgents: config.customAgents?.map((agent) => ({
        ...agent,
        mcpServers: {
          [`bound_${agent.name}`]: {
            type: "local",
            command: process.execPath,
            args: [
              fileURLToPath(new URL("./support/bound-mcp-server.js", import.meta.url)),
              agent.name, "repository-two", journal,
            ],
            tools: ["*"],
          },
        },
      })) ?? [],
    };
    session = await client.createSession(otherConfig);
    await select(session, "alpha");
    const oneBefore = await count("alpha");
    const twoBefore = await count("alpha", "repository-two");
    await call(session, "alpha");
    const oneDelta = await count("alpha") - oneBefore;
    const twoDelta = await count("alpha", "repository-two") - twoBefore;
    cases.push({
      name: "repository-binding-uses-second-launch", expected: 1,
      observed: twoDelta, passed: twoDelta === 1,
    }, {
      name: "repository-binding-does-not-reuse-first-launch", expected: 0,
      observed: oneDelta, passed: oneDelta === 0,
    });
    await session.disconnect();
    assert.equal(provider.counts().failures, 0, "PROVIDER_FAILED");
    assert.ok(cases.every((item) => item.passed), "BOUND_ISOLATION_REGRESSION");
    completed = true;
  } catch (error) {
    if (error instanceof Error && /^[A-Z_]+$/.test(error.message)) failureCode = error.message;
    else if (isRecord(error) && typeof error.code === "number") failureCode = error.code;
    throw new Error(`BOUND_MCP_PROBE_ERROR:${stage}:${failureCode ?? "unclassified"}`);
  } finally {
    const cleanupErrors = await client.stop();
    await provider.close();
    const report = {
      schemaVersion: 1, cliVersion: "1.0.83", sdkVersion: "1.0.13",
      platform: `${process.platform}-${process.arch}`,
      experiment: completed ? "COMPLETE" : "ERROR",
      isolation: completed && cases.every((item) => item.passed) ? "PASS" : "NO-GO",
      identityGate: "NO-GO",
      stage, failureCode, cases, provider: provider.counts(),
      cleanupErrors: cleanupErrors.length,
      omissions: [
        "Production enrollment registry, definition-origin resolution and stale-result invalidation are not implemented.",
        "Tests verify explicitly configured tool-call isolation, not an OS sandbox.",
      ],
    };
    await mkdir("test-results", { recursive: true });
    await writeFile("test-results/bound-mcp.json", `${JSON.stringify(report, null, 2)}\n`);
    console.log(`BOUND_MCP_COMPATIBILITY ${JSON.stringify(report)}`);
    await workspace.close();
    assert.equal(cleanupErrors.length, 0, "CLEANUP_FAILED");
  }
});
