import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveAll,
  CopilotClient,
  RuntimeConnection,
  ToolSet,
  type CopilotSession,
} from "@github/copilot-sdk";
import {
  conversationEnabled,
} from "../../src/conversation-memory.js";
import {
  registerBinding,
  type BindingReference,
} from "../../src/binding-registry.js";
import { enroll } from "../../src/enrollment.js";
import { createProductionFixture } from "./production-fixture.js";
import { startSyntheticProvider } from "./provider.js";
import {
  deferExtension,
  disableExtension,
  enableExtension,
} from "./extensions.js";

export async function createConversationFixture(names: string[]) {
  const production = await createProductionFixture();
  const modelContexts: string[] = [];
  const provider = await startSyntheticProvider({
    textOnly: true,
    observeRequest(messages) {
      modelContexts.push(JSON.stringify(messages));
    },
  });
  const references = new Map<string, BindingReference>();
  const root = join(production.config, "agents");
  try {
    await mkdir(root, { recursive: true });
    for (const name of names) {
      const path = join(root, `${name}.agent.md`);
      await writeFile(
        path,
        `---\nname: ${name}\ndescription: Synthetic automatic memory\ntools: [view]\n---\nRespond without calling tools.\n`,
      );
      const reference = await registerBinding({
        configRoot: production.config,
        definitionPath: path,
        origin: "user",
        originRoot: root,
        scope: { kind: "global" },
      });
      await enroll(reference);
      assert.equal(await conversationEnabled(reference), true);
      references.set(name, reference);
    }
  } catch (error) {
    await Promise.allSettled([provider.close(), production.close()]);
    throw error;
  }

  const clients = new Set<CopilotClient>();
  const sessions = new Set<CopilotSession>();
  const extensionIds = new WeakMap<CopilotClient, string>();
  const sessionExtensionIds = new Map<CopilotSession, string>();
  function createClient() {
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({
        path: fileURLToPath(
          new URL("../../../node_modules/.bin/copilot", import.meta.url),
        ),
      }),
      mode: "empty",
      workingDirectory: production.repository,
      baseDirectory: production.config,
      env: production.env,
      useLoggedInUser: false,
      logLevel: "none",
    });
    clients.add(client);
    return client;
  }
  async function open(client: CopilotClient, agent: string) {
    await client.start();
    let extensionId = extensionIds.get(client);
    if (!extensionId) {
      extensionId = await deferExtension(client);
      extensionIds.set(client, extensionId);
    }
    const session = await client.createSession({
      workingDirectory: production.repository,
      configDirectory: production.config,
      enableConfigDiscovery: true,
      requestExtensions: true,
      enableExperimentalMode: true,
      enableManagedSettings: false,
      extensionSdkPath: fileURLToPath(
        new URL(".", import.meta.resolve("@github/copilot-sdk")),
      ),
      model: "synthetic-model",
      provider: {
        type: "openai",
        baseUrl: provider.baseUrl,
        wireApi: "completions",
      },
      availableTools: new ToolSet(),
      agent,
      onPermissionRequest: approveAll,
      infiniteSessions: { enabled: false },
    });
    await enableExtension(session, extensionId);
    await session.rpc.tools.initializeAndValidate();
    sessions.add(session);
    sessionExtensionIds.set(session, extensionId);
    return session;
  }
  async function turn(session: CopilotSession, prompt: string) {
    const before = modelContexts.length;
    await session.sendAndWait({ prompt }, 20_000);
    assert.ok(modelContexts.length > before);
    return modelContexts.slice(before).join("\n");
  }
  async function disconnect(session: CopilotSession) {
    const extensionId = sessionExtensionIds.get(session);
    if (extensionId) await disableExtension(session, extensionId);
    await session.disconnect();
    sessions.delete(session);
    sessionExtensionIds.delete(session);
  }
  async function stop(client: CopilotClient) {
    assert.equal((await client.stop()).length, 0, "CLEANUP_FAILED");
    clients.delete(client);
  }
  async function close() {
    const disconnected = await Promise.allSettled(
      [...sessions].map(async (session) => {
        const extensionId = sessionExtensionIds.get(session);
        if (extensionId) await disableExtension(session, extensionId);
        await session.disconnect();
      }),
    );
    const stopped = await Promise.allSettled(
      [...clients].map((client) => client.stop()),
    );
    try {
      await provider.close();
    } finally {
      await production.close();
    }
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
  return {
    production,
    provider,
    references,
    createClient,
    open,
    turn,
    disconnect,
    stop,
    close,
  };
}
