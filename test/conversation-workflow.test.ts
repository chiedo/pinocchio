import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { approveAll, CopilotClient, RuntimeConnection, ToolSet, type CopilotSession } from "@github/copilot-sdk";
import { loadBinding, registerBinding } from "../src/binding-registry.js";
import type { BindingReference } from "../src/binding-registry.js";
import { conversationEnabled, setConversationEnabled } from "../src/conversation-memory.js";
import { enroll } from "../src/enrollment.js";
import { MemoryStore } from "../src/memory-store.js";
import { createProductionFixture } from "./support/production-fixture.js";
import { startSyntheticProvider } from "./support/provider.js";

test("native automatic capture survives cold sessions without model memory calls and respects isolation and pause",
  { timeout: 180_000 }, async () => {
    const f = await createProductionFixture();
    const modelContexts: string[] = [];
    const provider = await startSyntheticProvider({
      textOnly: true,
      observeRequest(messages) {
        modelContexts.push(JSON.stringify(messages));
      },
    });
    async function turn(agent: string, prompt: string) {
      const before = modelContexts.length;
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
          workingDirectory: f.repository, configDirectory: f.config, enableConfigDiscovery: true,
          requestExtensions: true, enableExperimentalMode: true, enableManagedSettings: false,
          extensionSdkPath: fileURLToPath(new URL(".", import.meta.resolve("@github/copilot-sdk"))),
          model: "synthetic-model", provider: { type: "openai", baseUrl: provider.baseUrl, wireApi: "completions" },
          availableTools: new ToolSet(), agent, onPermissionRequest: approveAll,
          infiniteSessions: { enabled: false },
        });
        await session.rpc.tools.initializeAndValidate();
        await session.sendAndWait({ prompt }, 20_000);
      } finally {
        await session?.disconnect();
        assert.equal((await client.stop()).length, 0, "CLEANUP_FAILED");
      }
      assert.ok(modelContexts.length > before);
      return modelContexts.slice(before).join("\n");
    }
    try {
      const references = new Map<string, BindingReference>();
      const root = join(f.config, "agents");
      await mkdir(root, { recursive: true });
      for (const name of ["automatic-alpha", "automatic-beta"]) {
        const path = join(root, `${name}.agent.md`);
        await writeFile(path, `---\nname: ${name}\ndescription: Synthetic automatic memory\ntools: [view]\n---\nRespond without calling tools.\n`);
        const reference = await registerBinding({
          configRoot: f.config, definitionPath: path, origin: "user", originRoot: root, scope: { kind: "global" },
        });
        await enroll(reference);
        assert.equal(await conversationEnabled(reference), true);
        references.set(name, reference);
      }
      await turn("automatic-alpha", "The synthetic mascot is Indigo Heron.");
      const reference = references.get("automatic-alpha");
      assert.ok(reference);
      const binding = await loadBinding(reference);
      const store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: "global" });
      try {
        assert.ok((await store.search("Indigo Heron")).items.length > 0, "USER_EVENT_NOT_CAPTURED");
      } finally { store.close(); }

      const recalled = await turn("automatic-alpha", "What was the mascot?");
      assert.match(recalled, /Pinocchio conversation memory/);
      assert.match(recalled, /Indigo Heron/);
      await setConversationEnabled(reference, false);
      const [isolated, paused] = await Promise.all([
        turn("automatic-beta", "What was the mascot?"),
        turn("automatic-alpha", "What was the mascot? Also: paused sentinel."),
      ]);
      assert.doesNotMatch(isolated, /Indigo Heron/);
      assert.doesNotMatch(paused, /Indigo Heron/);
      const pausedStore = await MemoryStore.open(reference, { namespace: binding.namespace, scope: "global" });
      try {
        assert.equal((await pausedStore.search("paused sentinel")).items.length, 0);
      } finally { pausedStore.close(); }
      assert.equal(provider.counts().toolRequests, 0);
      assert.equal(provider.counts().failures, 0);
    } finally {
      try { await provider.close(); } finally { await f.close(); }
    }
  });
