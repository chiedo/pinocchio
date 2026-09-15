import assert from "node:assert/strict";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { approveAll, CopilotClient, RuntimeConnection, ToolSet } from "@github/copilot-sdk";
import { setup } from "../src/setup-cli.js";
import { broadcastStatus, BROADCAST_DISPLAY_PROMPT } from "../src/broadcast.js";
import { upgradeBroadcast } from "../src/broadcast-cli.js";
import { EXTENSION_SEARCH_TOOL } from "../src/memory-protocol.js";
import { createWorkspace } from "./support/workspace.js";
import { startSyntheticProvider } from "./support/provider.js";

test("two open host sessions receive one broadcast without a user prompt or memory capture", { timeout: 120_000 }, async () => {
  const workspace = await createWorkspace();
  const observed: string[] = [];
  const provider = await startSyntheticProvider({
    textOnly: true,
    selectTool: (messages) => { observed.push(JSON.stringify(messages)); return "unused"; },
  });
  const config = await realpath(workspace.config);
  const repository = await realpath(workspace.repository);
  const clients: CopilotClient[] = [];
  try {
    await rm(join(repository, ".github", "extensions", "pinocchio"), { recursive: true });
    await setup({ configRoot: config, name: "broadcast-agent", global: true, tools: "view" });
    const sessions = [];
    for (let index = 0; index < 2; index++) {
      const client = new CopilotClient({
        connection: RuntimeConnection.forStdio({
          path: fileURLToPath(new URL("../../node_modules/.bin/copilot", import.meta.url)),
        }),
        mode: "empty", workingDirectory: repository, baseDirectory: config,
        env: workspace.env, useLoggedInUser: false, logLevel: "none",
      });
      clients.push(client);
      await client.start();
      const session = await client.createSession({
        workingDirectory: repository, configDirectory: config,
        enableConfigDiscovery: true, requestExtensions: true,
        extensionSdkPath: fileURLToPath(new URL(".", import.meta.resolve("@github/copilot-sdk"))),
        enableExperimentalMode: true, enableManagedSettings: false,
        model: "synthetic-model",
        provider: { type: "openai", baseUrl: provider.baseUrl, wireApi: "completions" },
        availableTools: new ToolSet().addCustom("*").addBuiltIn("view"),
        agent: "broadcast-agent", onPermissionRequest: approveAll, infiniteSessions: { enabled: false },
      });
      await session.rpc.tools.initializeAndValidate();
      sessions.push(session);
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
    await waitFor((status) => status.sessions.length === 2);
    const profile = join(config, "agents", "broadcast-agent.agent.md");
    await writeFile(profile, (await readFile(profile, "utf8")) + "\nSynthetic broadcast rule: keep replies short.\n");
    await upgradeBroadcast(config);
    await waitFor((status) => status.sessions.length === 2 && status.sessions.every((item) => item.status === "updated"));
    for (const session of sessions) {
      const events = await session.getEvents();
      const notices = events.filter((event) => event.type === "user.message" && event.data.content === BROADCAST_DISPLAY_PROMPT);
      assert.equal(notices.length, 1);
      assert.ok(events.some((event) => event.type === "assistant.message"));
      const search = await session.rpc.tools.execute({ name: EXTENSION_SEARCH_TOOL, arguments: { query: "Synthetic check complete" } });
      assert.notEqual(typeof search, "string");
      if (typeof search === "string") throw new Error("UNSTRUCTURED_SEARCH");
      assert.equal(search.resultType, "success");
      assert.deepEqual(JSON.parse(search.textResultForLlm).snippets, []);
      await session.disconnect();
    }
    assert.equal(provider.counts().failures, 0);
    assert.equal(provider.counts().requests, 2);
    assert.ok(observed.every((messages) => messages.includes("Synthetic broadcast rule: keep replies short.")));
  } finally {
    for (const client of clients) await client.stop();
    await provider.close();
    await workspace.close();
  }
});
