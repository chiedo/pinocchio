import assert from "node:assert/strict";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveAll,
  CopilotClient,
  RuntimeConnection,
  ToolSet,
  type CopilotSession,
} from "@github/copilot-sdk";
import { setup } from "../../src/setup-cli.js";
import { broadcastStatus } from "../../src/broadcast.js";
import { createWorkspace } from "./workspace.js";
import {
  startSyntheticProvider,
  type SyntheticProviderOptions,
} from "./provider.js";

export async function createBroadcastFixture(
  options: SyntheticProviderOptions = {},
  scoped = false,
  includeOtherAgent = true,
) {
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
    await rm(join(repository, ".github", "extensions", "pinocchio"), {
      recursive: true,
    });
    await rm(
      join(workspace.otherRepository, ".github", "extensions", "pinocchio"),
      { recursive: true },
    );
    await setup({
      configRoot: config,
      name: "broadcast-agent",
      tools: "view,web_search,exec",
      ...(scoped ? { repository } : { global: true }),
    });
    if (includeOtherAgent) {
      await setup({
        configRoot: config,
        name: "other-agent",
        global: true,
      });
      const otherProfile = join(config, "agents", "other-agent.agent.md");
      await writeFile(
        otherProfile,
        `${await readFile(otherProfile, "utf8")}\nSynthetic other role marker.\n`,
      );
    }
    const profile = join(config, "agents", "broadcast-agent.agent.md");
    const shared = join(config, "pinocchio", "AGENTS.md");
    await writeFile(
      profile,
      `${await readFile(profile, "utf8")}\nSynthetic original role marker.\n`,
    );
    async function openSession(
      workingDirectory = repository,
      agent = "broadcast-agent",
    ) {
      const client = new CopilotClient({
        connection: RuntimeConnection.forStdio({
          path: fileURLToPath(
            new URL("../../../node_modules/.bin/copilot", import.meta.url),
          ),
        }),
        mode: "empty",
        workingDirectory,
        baseDirectory: config,
        env: workspace.env,
        useLoggedInUser: false,
        logLevel: "none",
      });
      clients.push(client);
      await client.start();
      const session = await client.createSession({
        workingDirectory,
        configDirectory: config,
        enableConfigDiscovery: true,
        requestExtensions: true,
        extensionSdkPath: fileURLToPath(
          new URL(".", import.meta.resolve("@github/copilot-sdk")),
        ),
        enableExperimentalMode: true,
        enableManagedSettings: false,
        model: "synthetic-model",
        provider: {
          type: "openai",
          baseUrl: provider.baseUrl,
          wireApi: "completions",
        },
        availableTools: new ToolSet().addCustom("*").addBuiltIn("view"),
        agent,
        onPermissionRequest: approveAll,
        infiniteSessions: { enabled: false },
      });
      await session.rpc.tools.initializeAndValidate();
      sessions.push(session);
      return session;
    }
    async function waitFor(
      predicate: (
        status: Awaited<ReturnType<typeof broadcastStatus>>,
      ) => boolean,
    ) {
      const deadline = Date.now() + 30_000;
      let status = await broadcastStatus(config);
      while (!predicate(status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await broadcastStatus(config);
      }
      assert.ok(predicate(status), JSON.stringify(status));
    }
    return {
      workspace,
      config,
      profile,
      shared,
      provider,
      sessions,
      openSession,
      waitFor,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function sessionChat(session: CopilotSession) {
  return (await session.getEvents()).filter(
    (event) =>
      event.type === "user.message" || event.type === "assistant.message",
  );
}

export async function sessionWarnings(session: CopilotSession) {
  return (await session.getEvents()).filter(
    (event) =>
      event.type === "session.warning" &&
      event.data.message.startsWith("Pinocchio"),
  );
}
