import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  approveAll,
  CopilotClient,
  RuntimeConnection,
  ToolSet,
} from "@github/copilot-sdk";
import type { CopilotSession, SessionConfig } from "@github/copilot-sdk";
import { IDENTITY_DEADLINE_MS, isRecord } from "../src/identity.js";
import { IDENTITY_TOOL_NAME } from "../src/tool.js";
import { startSyntheticProvider } from "./support/provider.js";
import { createWorkspace } from "./support/workspace.js";

const PUBLIC_CLI_VERSION = "1.0.83";
const PUBLIC_SDK_VERSION = "1.0.13";

test("pinned public host loads and dispatches the fail-closed extension", { timeout: 180_000 }, async () => {
  const workspace = await createWorkspace();
  const provider = await startSyntheticProvider();
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
  const observations: { scenario: string; code: string; durationMs: number }[] = [];
  const modelCalls: { delegated: boolean; code: string; durationMs: number }[] = [];
  const helperNames = new Set<string>();
  const observationWaiters = new Set<() => void>();
  let stage = "host-start";
  let outcome: "PASS" | "ERROR" = "ERROR";
  let version = "unverified";
  let failureCode: string | number | null = null;

  const config: SessionConfig = {
    workingDirectory: workspace.repository,
    configDirectory: workspace.config,
    enableConfigDiscovery: true,
    requestExtensions: true,
    extensionSdkPath: fileURLToPath(
      new URL(".", import.meta.resolve("@github/copilot-sdk")),
    ),
    enableExperimentalMode: true,
    enableManagedSettings: false,
    model: "synthetic-model",
    provider: { type: "openai", baseUrl: provider.baseUrl, wireApi: "completions" },
    availableTools: new ToolSet()
      .addCustom(IDENTITY_TOOL_NAME)
      .addBuiltIn([IDENTITY_TOOL_NAME, "task", "read_agent"]),
    customAgents: [
      {
        name: "foreground",
        displayName: "Synthetic foreground",
        prompt: "Synthetic fixture. Call pinocchio_identity_status only when asked.",
        tools: [IDENTITY_TOOL_NAME, "task", "read_agent"],
      },
      ...["helper-alpha", "helper-beta"].map((name) => ({
        name,
        displayName: "Shared synthetic label",
        prompt: "Synthetic fixture. Call pinocchio_identity_status once, then stop.",
        tools: [IDENTITY_TOOL_NAME],
      })),
    ],
    agent: "foreground",
    onPermissionRequest: approveAll,
    infiniteSessions: { enabled: false },
  };

  function observe(session: CopilotSession) {
    const starts = new Map<string, { time: number; delegated: boolean }>();
    const unsubscribeStart = session.on("tool.execution_start", (event) => {
      if (event.data.toolName === IDENTITY_TOOL_NAME) {
        starts.set(event.data.toolCallId, {
          time: performance.now(),
          delegated: event.agentId !== undefined,
        });
      }
    });
    const unsubscribeEnd = session.on("tool.execution_complete", (event) => {
      const start = starts.get(event.data.toolCallId);
      if (!start) return;
      starts.delete(event.data.toolCallId);
      const text = event.data.result?.content ?? event.data.error?.message ?? "";
      const code = text.includes("HOST_IDENTITY_UNSUPPORTED")
        ? "HOST_IDENTITY_UNSUPPORTED"
        : "UNEXPECTED_TOOL_RESULT";
      modelCalls.push({
        delegated: start.delegated,
        code,
        durationMs: Math.ceil(performance.now() - start.time),
      });
      for (const notify of observationWaiters) notify();
    });
    const unsubscribeHelpers = session.on("subagent.started", (event) => {
      if (["helper-alpha", "helper-beta"].includes(event.data.agentName)) {
        helperNames.add(event.data.agentName);
      }
    });
    return () => {
      unsubscribeStart();
      unsubscribeEnd();
      unsubscribeHelpers();
    };
  }

  async function dispatch(
    session: CopilotSession,
    scenario: string,
    args: Record<string, string> = {},
    expectedCode = "HOST_IDENTITY_UNSUPPORTED",
  ) {
    stage = scenario;
    const start = performance.now();
    const result = await session.rpc.tools.execute({
      name: IDENTITY_TOOL_NAME,
      arguments: args,
    });
    assert.notEqual(typeof result, "string", "Expected a structured failure result");
    if (typeof result === "string") throw new Error("UNSTRUCTURED_TOOL_RESULT");
    assert.equal(result.resultType, "failure");
    const data: unknown = JSON.parse(result.textResultForLlm);
    assert.ok(isRecord(data));
    assert.equal(data.code, expectedCode);
    assert.deepEqual(data.scopes, {
      repository: "unavailable",
      global: "unavailable",
    });
    assert.equal(Object.hasOwn(data, "namespace"), false);
    const durationMs = Math.ceil(performance.now() - start);
    observations.push({ scenario, code: expectedCode, durationMs });
    assert.ok(durationMs < IDENTITY_DEADLINE_MS, `${scenario}: identity deadline exceeded`);
  }

  async function load(session: CopilotSession) {
    stage = "extensions-reload";
    await session.rpc.extensions.reload();
    stage = "extensions-list";
    const { extensions } = await session.rpc.extensions.list();
    assert.ok(
      extensions.some(
        (extension) => extension.name === "pinocchio" && extension.status === "running",
      ),
      "PUBLIC_EXTENSION_NOT_RUNNING",
    );
    stage = "tools-initialize";
    await session.rpc.tools.initializeAndValidate();
  }

  async function selectAgent(session: CopilotSession, name: string) {
    await session.rpc.agent.select({ name });
    await session.rpc.tools.initializeAndValidate();
  }

  async function waitForHelperEvents() {
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (modelCalls.filter((call) => call.delegated).length >= 2) {
          clearTimeout(timer);
          observationWaiters.delete(check);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        observationWaiters.delete(check);
        reject(new Error("HOST_EVENT_DELIVERY_DEADLINE_EXCEEDED"));
      }, IDENTITY_DEADLINE_MS);
      observationWaiters.add(check);
      check();
    });
  }

  try {
    const sdkPackage: unknown = JSON.parse(
      await readFile(
        new URL("../package.json", import.meta.resolve("@github/copilot-sdk")),
        "utf8",
      ),
    );
    assert.ok(isRecord(sdkPackage));
    assert.equal(sdkPackage.version, PUBLIC_SDK_VERSION);
    assert.equal(sdkPackage.copilotCliVersion, PUBLIC_CLI_VERSION);
    await client.start();
    version = (await client.getStatus()).version;
    assert.equal(version, PUBLIC_CLI_VERSION, "Unexpected public runtime version");
    stage = "session-create";
    let session = await client.createSession(config);
    await load(session);

    stage = "foreground";
    await dispatch(session, "foreground");
    await dispatch(session, "model-owner-injection", { owner: "helper-alpha" }, "INVALID_TOOL_ARGUMENTS");
    await dispatch(session, "model-scope-injection", { scope: "global" }, "INVALID_TOOL_ARGUMENTS");

    stage = "selected-agents";
    const { agents } = await session.rpc.agent.list();
    const alpha = agents.find((agent) => agent.name === "helper-alpha");
    const beta = agents.find((agent) => agent.name === "helper-beta");
    assert.ok(alpha && beta, "SYNTHETIC_HELPERS_NOT_DISCOVERED");
    assert.equal(alpha.displayName, beta.displayName);
    assert.notEqual(alpha.id, beta.id);
    await selectAgent(session, alpha.id);
    await dispatch(session, "duplicate-display-name-alpha");
    await selectAgent(session, beta.id);
    await dispatch(session, "duplicate-display-name-beta");
    await selectAgent(session, "foreground");

    stage = "concurrent-switch";
    await Promise.all([
      dispatch(session, "concurrent-call-alpha"),
      dispatch(session, "concurrent-call-beta"),
      selectAgent(session, alpha.id),
    ]);
    await dispatch(session, "after-foreground-switch");
    await selectAgent(session, "foreground");

    stage = "model-tool-boundary";
    const stopObserving = observe(session);
    await session.sendAndWait({ prompt: "Run the synthetic identity diagnostic once." }, 30_000);
    assert.ok(modelCalls.length >= 1, "MODEL_DID_NOT_REACH_EXTENSION");

    stage = "delegated-tool-boundary";
    const taskResults = await Promise.all(
      [alpha, beta].map((agent) =>
        session.rpc.tools.execute({
          name: "task",
          arguments: {
            agent_type: agent.id,
            name: "shared-synthetic-helper",
            description: "Run synthetic identity diagnostic",
            prompt: "Run the synthetic identity diagnostic once.",
            mode: "sync",
          },
        }),
      ),
    );
    assert.equal(taskResults.length, 2);
    await waitForHelperEvents();
    assert.equal(helperNames.size, 2, "NAMED_HELPERS_DID_NOT_START");
    assert.ok(
      modelCalls.filter((call) => call.delegated).length >= 2,
      "DELEGATED_CALLS_DID_NOT_REACH_EXTENSION",
    );
    assert.ok(modelCalls.every((call) => call.code === "HOST_IDENTITY_UNSUPPORTED"));
    assert.ok(modelCalls.every((call) => call.durationMs < IDENTITY_DEADLINE_MS));
    stopObserving();

    stage = "reload";
    await load(session);
    await dispatch(session, "extension-reload");
    await session.rpc.agent.reload();
    await session.rpc.tools.initializeAndValidate();
    await dispatch(session, "definition-reload");

    stage = "resume";
    const sessionId = session.sessionId;
    await session.disconnect();
    session = await client.resumeSession(sessionId, config);
    await load(session);
    await dispatch(session, "session-resume");
    await session.disconnect();

    stage = "cold-resume";
    assert.equal((await client.stop()).length, 0, "HOST_RESTART_CLEANUP_FAILED");
    client = createClient();
    await client.start();
    assert.equal((await client.getStatus()).version, PUBLIC_CLI_VERSION);
    session = await client.resumeSession(sessionId, config);
    await load(session);
    await dispatch(session, "cold-session-resume");
    await session.disconnect();

    stage = "repository-scope";
    const other = await client.createSession({
      ...config,
      workingDirectory: workspace.otherRepository,
    });
    await load(other);
    await dispatch(other, "other-repository");
    await other.disconnect();
    assert.equal(provider.counts().failures, 0, "SYNTHETIC_PROVIDER_FAILED");
    outcome = "PASS";
    stage = "complete";
  } catch (error) {
    if (
      isRecord(error) &&
      (typeof error.code === "number" ||
        (typeof error.code === "string" && /^[A-Z_]+$/.test(error.code)))
    ) {
      failureCode = error.code;
    }
    if (error instanceof Error && /^[A-Z_]+$/.test(error.message)) {
      failureCode = error.message;
    }
    throw new Error(
      `PUBLIC_HOST_PROBE_FAILED:${stage}; code=${failureCode ?? "unclassified"}; no raw host logs are published`,
    );
  } finally {
    const cleanupErrors = await client.stop();
    await provider.close();
    const report = {
      schemaVersion: 1,
      cliVersion: version,
      sdkVersion: PUBLIC_SDK_VERSION,
      platform: `${process.platform}-${process.arch}`,
      syntheticHarness: outcome,
      stage,
      failureCode,
      identityGate: "NO-GO",
      reason: "No authoritative per-call agent definition/origin and scope binding.",
      namespacesSelected: 0,
      directCalls: observations,
      modelToolCalls: modelCalls,
      namedHelpersObserved: helperNames.size,
      provider: provider.counts(),
      cleanupErrors: cleanupErrors.length,
      omissions: [
        "No positive namespace isolation or persistence claim.",
        "No real-model behavior, desktop or operating-system matrix certification.",
      ],
    };
    await mkdir("test-results", { recursive: true });
    await writeFile("test-results/public-host.json", `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PINOCCHIO_COMPATIBILITY ${JSON.stringify(report)}`);
    await workspace.close();
    assert.equal(cleanupErrors.length, 0, "PUBLIC_HOST_CLEANUP_FAILED");
  }
});
