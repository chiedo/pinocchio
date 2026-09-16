import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  approveAll,
  CopilotClient,
  RuntimeConnection,
  ToolSet,
} from "@github/copilot-sdk";
import type { SessionConfig } from "@github/copilot-sdk";
import { registerBinding, loadBinding, type BindingReference } from "./binding-registry.js";
import { enroll } from "./enrollment.js";
import { MemoryStore } from "./memory-store.js";
import { setConversationEnabled } from "./conversation-memory.js";
import {
  EXTENSION_SAVE_TOOL,
  EXTENSION_SEARCH_TOOL,
  ToolError,
} from "./memory-protocol.js";
import {
  offeredToolName,
  startSyntheticProvider,
} from "../test/support/provider.js";
import { pinnedCliPath, PUBLIC_HOST, PUBLIC_NODE } from "./release.js";

const execute = promisify(execFile);
export const installedHost = pinnedCliPath();

async function measured<T>(
  timings: Record<string, number>,
  name: string,
  action: () => Promise<T>,
) {
  const started = performance.now();
  try {
    return await action();
  } finally {
    timings[name] = Math.round(performance.now() - started);
  }
}

export async function prerequisites(previewPlatform = false) {
  if (process.versions.node !== PUBLIC_NODE) throw new ToolError("NODE_22_18_0_REQUIRED");
  const supported = process.platform === "linux" && process.arch === "x64";
  if (!supported && !(previewPlatform && process.platform === "darwin")) throw new ToolError("PLATFORM_UNVALIDATED");
  const probe = await mkdtemp(join(tmpdir(), "pinocchio-version-check-"));
  let version;
  try {
    const config = join(probe, ".copilot");
    version = await execute(installedHost, ["--version"], {
      timeout: 15_000, maxBuffer: 4096,
      env: { PATH: process.env.PATH, HOME: probe, USERPROFILE: probe, COPILOT_HOME: config,
        COPILOT_CONFIG_DIR: config, COPILOT_OFFLINE: "true", DO_NOT_TRACK: "1" },
    });
  } finally { await rm(probe, { recursive: true, force: true }); }
  if (!new RegExp(`CLI ${PUBLIC_HOST.replaceAll(".", "\\.")}(?:\\.|\\s|$)`).test(version.stdout)) {
    throw new ToolError("PINNED_CLI_REQUIRED");
  }
  return { cli: PUBLIC_HOST, node: PUBLIC_NODE, platform: process.platform, arch: process.arch,
    platformCertification: supported ? "synthetic-baseline" : "unvalidated-preview" };
}

/** No account, real profiles, model inference or user memory enters this diagnostic. */
export async function diagnose(previewPlatform = false) {
  const timingsMs: Record<string, number> = {};
  const host = await measured(timingsMs, "prerequisites", () =>
    prerequisites(previewPlatform));
  const root = await measured(timingsMs, "workspace", async () =>
    realpath(await mkdtemp(join(tmpdir(), "pinocchio-install-check-"))));
  const home = join(root, "home");
  const config = join(home, "custom-config");
  const repository = join(root, "repository");
  const cases: string[] = [];
  let stage = "setup";
  let client: CopilotClient | undefined;
  const observed: string[] = [];
  const target = (messages: Record<string, unknown>[]) => {
    for (const message of messages) if (message.role === "tool") {
      observed.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    }
    const prompt = String(messages.findLast((message) => message.role === "user")?.content ?? "");
    return { name: prompt.includes("HELPER") ? "check-helper" : "check-main",
      delegate: prompt.includes("DELEGATE"), save: prompt.includes("SAVE") };
  };
  const provider = await startSyntheticProvider({
    replyWithoutTools: true,
    selectTool(messages, tools) {
      const t = target(messages);
      if (t.delegate) return "task";
      return offeredToolName(
        tools,
        t.save ? EXTENSION_SAVE_TOOL : EXTENSION_SEARCH_TOOL,
      );
    },
    toolArguments(messages) {
      const t = target(messages);
      if (t.delegate) return { agent_type: "check-helper", name: "independent-helper",
        description: "Synthetic helper check", prompt: `HELPER ${t.save ? "SAVE" : "SEARCH"} synthetic`, mode: "sync" };
      return t.save ? { action: "remember", operationId: `save-${t.name}`,
        note: { content: `synthetic memory marker ${t.name}`, kind: "fact",
          evidence: [{ kind: "manual_entry", reference: { type: "text", value: "invented installation check" } }] } }
        : { query: "synthetic memory" };
    },
  });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".state"), COPILOT_HOME: config, COPILOT_CONFIG_DIR: config,
    TMPDIR: root, NO_COLOR: "1", CI: "true", DO_NOT_TRACK: "1", COPILOT_TELEMETRY_DISABLED: "1",
    COPILOT_PROVIDER_BASE_URL: provider.baseUrl, COPILOT_PROVIDER_TYPE: "openai",
    COPILOT_PROVIDER_WIRE_API: "completions", COPILOT_MODEL: "synthetic-model",
    COPILOT_OFFLINE: "true",
  };
  try {
    const references = await measured(timingsMs, "setup", async () => {
      await mkdir(join(config, "agents"), { recursive: true, mode: 0o700 });
      await mkdir(repository, { mode: 0o700 });
      await execute("git", ["init", "--quiet", "--initial-branch=main", repository], { env });
      const enrolled: BindingReference[] = [];
      for (const name of ["check-main", "check-helper"]) {
        const path = join(config, "agents", `${name}.agent.md`);
        await writeFile(path, `---\nname: ${name}\ndescription: Synthetic installation check\ntools: [view, task]\n---\nUse your scoped tools.\n`);
        const ref = await registerBinding({ configRoot: config, definitionPath: path, origin: "user",
          originRoot: join(config, "agents"), scope: { kind: "repository", root: repository } });
        await enroll(ref);
        // This gate checks explicit saves/deletes; automatic capture has its own native-host gate.
        await setConversationEnabled(ref, false);
        enrolled.push(ref);
      }
      return enrolled;
    });
    cases.push("tools-verified-before-enrollment");
    client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: installedHost }),
      mode: "empty",
      workingDirectory: repository,
      baseDirectory: config,
      env,
      useLoggedInUser: false,
      logLevel: "none",
    });
    const sessionConfig: SessionConfig = {
      workingDirectory: repository,
      configDirectory: config,
      enableConfigDiscovery: true,
      requestExtensions: true,
      enableExperimentalMode: true,
      enableManagedSettings: false,
      extensionSdkPath: fileURLToPath(new URL(".", import.meta.resolve("@github/copilot-sdk"))),
      model: "synthetic-model",
      provider: { type: "openai", baseUrl: provider.baseUrl, wireApi: "completions" },
      availableTools: new ToolSet().addCustom("*").addBuiltIn(["view", "task"]),
      agent: "check-main",
      onPermissionRequest: approveAll,
      infiniteSessions: { enabled: false },
    };
    await measured(timingsMs, "client-start", () => client!.start());
    async function withSession(run: (session: Awaited<ReturnType<CopilotClient["createSession"]>>) => Promise<void>) {
      const session = await client!.createSession(sessionConfig);
      try {
        await session.rpc.tools.initializeAndValidate();
        await run(session);
      } finally {
        await client!.deleteSession(session.sessionId);
      }
    }
    async function turn(
      session: Awaited<ReturnType<CopilotClient["createSession"]>>,
      prompt: string,
      expected: string,
      absent?: string,
    ) {
      stage = prompt;
      observed.length = 0;
      const delegated = prompt.includes("DELEGATE");
      const save = prompt.includes("SAVE");
      let direct = "";
      if (delegated) {
        await measured(
          timingsMs,
          prompt.toLowerCase().replaceAll(" ", "-"),
          () => session.sendAndWait({ prompt }, 45_000),
        );
        await measured(
          timingsMs,
          `${prompt.toLowerCase().replaceAll(" ", "-")}-cleanup`,
          () => session.rpc.cancelAllBackgroundAgents(),
        );
      } else {
        const result = await measured(
          timingsMs,
          prompt.toLowerCase().replaceAll(" ", "-"),
          () => session.rpc.tools.execute({
              name: save ? EXTENSION_SAVE_TOOL : EXTENSION_SEARCH_TOOL,
              arguments: save
                ? {
                    action: "remember",
                    operationId: "save-check-main",
                    note: {
                      content: "synthetic memory marker check-main",
                      kind: "fact",
                      evidence: [{
                        kind: "manual_entry",
                        reference: {
                          type: "text",
                          value: "invented installation check",
                        },
                      }],
                    },
                  }
                : { query: "synthetic memory" },
            }),
        );
        direct = typeof result === "string"
          ? result
          : result.textResultForLlm;
      }
      const results = `${observed.join("\n")}\n${direct}`;
      assert.ok(results.includes(expected), "EXPECTED_SYNTHETIC_TOOL_RESULT_MISSING");
      if (absent) assert.ok(!results.includes(absent), "CROSS_SCOPE_SYNTHETIC_RESULT");
      cases.push(prompt.toLowerCase().replaceAll(" ", "-"));
    }
    await withSession(async (session) => {
      await turn(session, "FOREGROUND SAVE", "committed");
      await turn(session, "DELEGATE SAVE", "committed");
    });
    await withSession(async (session) => {
      await turn(session, "FOREGROUND SEARCH", "synthetic memory marker check-main", "synthetic memory marker check-helper");
      await turn(session, "DELEGATE SEARCH", "synthetic memory marker check-helper", "synthetic memory marker check-main");
    });
    for (const ref of references) {
      const binding = await loadBinding(ref);
      const store = await MemoryStore.open(ref, { namespace: binding.namespace, scope: "repository" });
      try {
        const saved = await store.operationStatus(`save-${binding.definition.path.endsWith("check-main.agent.md") ? "check-main" : "check-helper"}`);
        assert.equal(saved.status, "committed");
        assert.ok("recordId" in saved && typeof saved.recordId === "string");
        await store.forget(saved.recordId, 1, "synthetic-delete");
      } finally { store.close(); }
    }
    await withSession(async (session) => {
      await turn(session, "FOREGROUND SEARCH DELETED", '"snippets":[]');
      await turn(session, "DELEGATE SEARCH DELETED", '"snippets":[]');
    });
    assert.equal(provider.counts().failures, 0);
    return { status: "passed", host, cases, sessions: 3, timingsMs, syntheticOnly: true,
      liveCertification: "unvalidated", desktop: "unvalidated" };
  } catch (error) {
    const toolCode = /"code"\s*:\s*"([A-Z_]+)"/.exec(observed.join("\n"))?.[1];
    const providerCode = provider.counts().failureCodes[0];
    const reason = toolCode ?? providerCode ??
      (error instanceof Error && error.message === "EXPECTED_SYNTHETIC_TOOL_RESULT_MISSING" ? "RESULT_MISSING" : "HOST_CALL_FAILED");
    throw new ToolError(`INSTALL_DIAGNOSTIC_FAILED_${stage.replaceAll(" ", "_")}_${reason}`);
  } finally {
    try {
      if (client) {
        const cleanupErrors = await measured(timingsMs, "client-stop", () => client!.stop());
        if (cleanupErrors.length) throw new ToolError("INSTALL_DIAGNOSTIC_CLEANUP_FAILED");
      }
    } finally {
      try { await measured(timingsMs, "provider-close", () => provider.close()); }
      finally {
        await measured(timingsMs, "workspace-cleanup", () =>
          rm(root, { recursive: true, force: true }));
      }
    }
  }
}
