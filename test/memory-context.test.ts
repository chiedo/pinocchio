import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { approveAll, CopilotClient, RuntimeConnection, ToolSet, type CopilotSession } from "@github/copilot-sdk";
import type { SessionHooks } from "@github/copilot-sdk";
import { createProductionFixture } from "./support/production-fixture.js";
import { startSyntheticProvider } from "./support/provider.js";

test("public host supplies trusted root/recipient context to pre-MCP hooks", { timeout: 120_000 }, async () => {
  const f = await createProductionFixture();
  const provider = await startSyntheticProvider({ selectTool: () => "context-context_probe" });
  const prompts: { root: string; recipient: string }[] = [];
  const calls: { root: string; recipient: string; toolCall: string | undefined; promptSeen: boolean }[] = [];
  const hooks: SessionHooks = {
    onUserPromptSubmitted(input, invocation) {
      prompts.push({ root: invocation.sessionId, recipient: input.sessionId });
    },
    onPreMcpToolCall(input, invocation) {
      const context = {
        root: invocation.sessionId, recipient: input.sessionId,
        toolCall: input.toolCallId,
        promptSeen: prompts.some((prompt) => prompt.root === invocation.sessionId && prompt.recipient === input.sessionId),
      };
      calls.push(context);
      return { metaToUse: { synthetic: context } };
    },
  };
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: fileURLToPath(new URL("../../node_modules/.bin/copilot", import.meta.url)),
    }),
    mode: "empty", workingDirectory: f.repository, baseDirectory: f.config,
    env: f.env, useLoggedInUser: false, logLevel: "none",
  });
  let session: CopilotSession | undefined;
  try {
    await client.start();
    session = await client.createSession({
      workingDirectory: f.repository, configDirectory: f.config,
      model: "synthetic-model",
      provider: { type: "openai", baseUrl: provider.baseUrl, wireApi: "completions" },
      availableTools: new ToolSet().addMcp("*").addBuiltIn("task"),
      enableManagedSettings: false, onPermissionRequest: approveAll,
      infiniteSessions: { enabled: false }, hooks, agent: "foreground",
      customAgents: ["foreground", "helper"].map((name) => ({
        name, prompt: "Call the synthetic context tool once.",
        tools: ["context-context_probe", ...(name === "foreground" ? ["task"] : [])],
        mcpServers: { context: {
          type: "local", command: process.execPath,
          args: [fileURLToPath(new URL("./support/context-mcp.js", import.meta.url))],
          tools: ["context_probe"],
        } },
      })),
    });
    await session.rpc.tools.initializeAndValidate();
    await session.sendAndWait({ prompt: "Check foreground context." }, 20_000);
    const foreground = calls.at(-1);
    assert.ok(foreground?.root && foreground.recipient && foreground.toolCall);
    assert.equal(foreground.root, session.sessionId);
    assert.equal(foreground.recipient, session.sessionId);
    assert.equal(foreground.promptSeen, true);
    await session.rpc.tools.execute({ name: "task", arguments: {
      agent_type: "helper", name: "synthetic-helper", description: "Verify execution context",
      prompt: "Check helper context.", mode: "sync",
    } });
    const helper = calls.at(-1);
    assert.ok(helper?.toolCall);
    assert.equal(helper.root, session.sessionId);
    assert.notEqual(helper.recipient, foreground.recipient);
    assert.equal(helper.promptSeen, true, "HELPER_REQUEST_HOOK_REQUIRED");
  } finally {
    await session?.disconnect();
    assert.equal((await client.stop()).length, 0, "CLEANUP_FAILED");
    await provider.close();
    await f.close();
  }
});
