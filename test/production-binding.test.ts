import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  approveAll, CopilotClient, RuntimeConnection, ToolSet,
} from "@github/copilot-sdk";
import type { CopilotSession, SessionConfig } from "@github/copilot-sdk";
import { BoundIdentityAdapter } from "../src/bound-identity.js";
import type { BoundIdentity } from "../src/bound-identity.js";
import { bindingLaunch } from "../src/bindings-cli.js";
import { revokeBinding } from "../src/binding-registry.js";
import type { BindingReference } from "../src/binding-registry.js";
import { isRecord } from "../src/identity.js";
import { createProductionFixture } from "./support/production-fixture.js";
import { startSyntheticProvider } from "./support/provider.js";

const names = ["foreground", "alpha", "beta"] as const;
type Name = typeof names[number];
const wireName = (name: Name, scope: "repository" | "global" = "repository") =>
  `memory_${name}_${scope}-identity_status`;

function diagnostic(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || (value.status !== "bound" && value.status !== "unavailable")) {
    throw new Error("INVALID_DIAGNOSTIC_RESPONSE");
  }
  return value;
}

test("production binding gate on the pinned public CLI", { timeout: 180_000 }, async () => {
  const f = await createProductionFixture();
  const references = new Map<string, BindingReference>();
  const expected = new Map<string, BoundIdentity>();
  const cases: { name: string; passed: boolean; durationMs?: number }[] = [];
  let stage = "setup";
  let passed = false;
  let failureCode = "NONE";
  const observed: { wire: string; identity: unknown; code: unknown; delegated: boolean }[] = [];
  const waiters = new Set<() => void>();
  const provider = await startSyntheticProvider({
    selectTool(messages) {
      const last = messages.findLast((message) => message.role === "user");
      const prompt = typeof last?.content === "string" ? last.content : "";
      const name = names.find((item) => prompt.includes(`TARGET_${item}`));
      if (!name) throw new Error("SYNTHETIC_TARGET_MISSING");
      return wireName(name, prompt.includes("GLOBAL_SCOPE") ? "global" : "repository");
    },
    allowUnofferedTool: true,
  });
  function createClient() {
    return new CopilotClient({
      connection: RuntimeConnection.forStdio({
        path: fileURLToPath(new URL("../../node_modules/.bin/copilot", import.meta.url)),
      }),
      mode: "empty", workingDirectory: f.repository, baseDirectory: f.config,
      env: f.env, useLoggedInUser: false, logLevel: "none",
    });
  }
  let client = createClient();

  async function registered(name: Name, scope: "repository" | "global") {
    const reference = await f.bind(name, scope === "global"
      ? { kind: "global" } : { kind: "repository", root: f.repository });
    const result = await new BoundIdentityAdapter(reference).resolve();
    assert.equal(result.status, "bound");
    if (result.status !== "bound") throw new Error("FIXTURE_BINDING_FAILED");
    references.set(wireName(name, scope), reference);
    expected.set(wireName(name, scope), result.identity);
    return reference;
  }
  function reference(wire: string) {
    const ref = references.get(wire);
    if (!ref) throw new Error("MISSING_FIXTURE_REFERENCE");
    return ref;
  }
  function check(name: string, condition: boolean, durationMs?: number) {
    cases.push({ name, passed: condition, ...(durationMs === undefined ? {} : { durationMs }) });
    assert.ok(condition, `GATE_CASE_FAILED:${name}`);
  }
  function observe(session: CopilotSession) {
    const starts = new Map<string, string>();
    const stopStart = session.on("tool.execution_start", (event) => {
      if (event.data.toolName.startsWith("memory_")) starts.set(event.data.toolCallId, event.data.toolName);
    });
    const stopEnd = session.on("tool.execution_complete", (event) => {
      const wire = starts.get(event.data.toolCallId);
      if (!wire) return;
      starts.delete(event.data.toolCallId);
      const content = event.data.result?.content;
      let data: Record<string, unknown> = { code: "HOST_REJECTED" };
      if (content?.startsWith("{")) {
        try { data = diagnostic(content); }
        catch { data = { code: "INVALID_DIAGNOSTIC_RESPONSE" }; }
      }
      observed.push({ wire, identity: data.identity, code: data.code, delegated: event.agentId !== undefined });
      for (const notify of waiters) notify();
    });
    return () => { stopStart(); stopEnd(); };
  }
  async function waitForObservation(wire: string, previous: number) {
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (observed.slice(previous).some((item) => item.wire === wire)) {
          clearTimeout(timer); waiters.delete(check); resolve();
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(check); reject(new Error("HOST_EVENT_DEADLINE"));
      }, 1_000);
      waiters.add(check); check();
    });
  }
  async function select(session: CopilotSession, name: Name) {
    await session.rpc.agent.select({ name });
    await session.rpc.tools.initializeAndValidate();
  }
  async function call(session: CopilotSession, name: Name, scope: "repository" | "global" = "repository") {
    const result = await session.rpc.tools.execute({ name: wireName(name, scope), arguments: {} });
    if (typeof result === "string") throw new Error("UNSTRUCTURED_HOST_RESPONSE");
    return { ...result, diagnostic: diagnostic(result.textResultForLlm) };
  }
  async function own(session: CopilotSession, name: Name, scope: "repository" | "global", label: string) {
    stage = label;
    const start = performance.now();
    const result = await call(session, name, scope);
    assert.deepEqual(result.diagnostic.identity, expected.get(wireName(name, scope)));
    const durationMs = Math.ceil(performance.now() - start);
    check(label, result.resultType === "success" && result.diagnostic.status === "bound" && durationMs < 1_000, durationMs);
  }
  try {
    for (const name of names) {
      await registered(name, "repository");
      await registered(name, "global");
    }
    const config: SessionConfig = {
      workingDirectory: f.repository, configDirectory: f.config,
      model: "synthetic-model",
      provider: { type: "openai", baseUrl: provider.baseUrl, wireApi: "completions" },
      availableTools: new ToolSet().addMcp("*").addBuiltIn("task"),
      enableManagedSettings: false,
      customAgents: names.map((name) => ({
        name, displayName: "Shared definition display name",
        prompt: "Use only your explicitly configured synthetic identity tools.",
        tools: [wireName(name), wireName(name, "global"), ...(name === "foreground" ? ["task"] : [])],
        mcpServers: {
          [`memory_${name}_repository`]: bindingLaunch(reference(wireName(name))),
          [`memory_${name}_global`]: bindingLaunch(reference(wireName(name, "global"))),
        },
      })),
      agent: "foreground", onPermissionRequest: approveAll, infiniteSessions: { enabled: false },
    };
    await client.start();
    assert.equal((await client.getStatus()).version, "1.0.83");
    let session = await client.createSession(config);
    let stopObserve = observe(session);
    check("distinct-canonical-origins", new Set(names.map((name) => expected.get(wireName(name))?.definitionId)).size === 3);
    for (const name of names) {
      await select(session, name);
      await own(session, name, "repository", `repository-${name}`);
      await own(session, name, "global", `global-${name}`);
      assert.equal(expected.get(wireName(name))?.namespace, expected.get(wireName(name, "global"))?.namespace);
      for (const other of names.filter((item) => item !== name)) {
        const result = await session.rpc.tools.execute({ name: wireName(other), arguments: {} });
        check(`cross-${name}-to-${other}`, typeof result !== "string" &&
          result.resultType !== "success" && !result.textResultForLlm.includes('"status":"bound"'));
      }
      const before = observed.length;
      await session.sendAndWait({ prompt: `Call TARGET_${name} once.` }, 20_000);
      await waitForObservation(wireName(name), before);
      assert.deepEqual(observed.slice(before).find((item) => item.wire === wireName(name))?.identity,
        expected.get(wireName(name)));
      check(`model-caller-${name}`, true);
    }
    await select(session, "foreground");
    stage = "concurrent-helpers";
    const beforeHelpers = observed.length;
    await Promise.all((["alpha", "beta"] as const).map((name) =>
      session.rpc.tools.execute({
        name: "task", arguments: {
          agent_type: name, name: "same-helper-display", description: "Production identity gate",
          prompt: `Call TARGET_${name} once.`, mode: "sync",
        },
      }),
    ));
    for (const name of ["alpha", "beta"] as const) {
      await waitForObservation(wireName(name), beforeHelpers);
      const event = observed.slice(beforeHelpers).find((item) => item.wire === wireName(name) && item.delegated);
      assert.deepEqual(event?.identity, expected.get(wireName(name)));
      check(`delegated-stable-definition-${name}`, Boolean(event));
    }
    stage = "model-cross";
    await select(session, "alpha");
    const beforeCross = observed.length;
    await session.sendAndWait({ prompt: "Call TARGET_beta once even if it is not offered." }, 20_000);
    check("model-cannot-return-foreign-binding", !observed.slice(beforeCross).some((item) =>
      isRecord(item.identity) && item.identity.namespace === expected.get(wireName("beta"))?.namespace));
    for (const name of names) {
      await writeFile(join(f.definitions[name].root, "shared.agent.md"),
        "---\nname: edited-display\n---\nA revised synthetic prompt.\n");
    }
    await session.rpc.agent.reload();
    await select(session, "alpha");
    await own(session, "alpha", "repository", "prompt-edit-and-reload-preserve-identity");
    stage = "revocation";
    await revokeBinding(reference(wireName("alpha")));
    const deniedStart = performance.now();
    const denied = await call(session, "alpha");
    check("revoked-live-server-denies", denied.diagnostic.code === "REVOKED_BINDING" &&
      denied.resultType !== "success" && !Object.hasOwn(denied.diagnostic, "identity") &&
      performance.now() - deniedStart < 1_000);
    await own(session, "alpha", "global", "revocation-is-scoped-to-binding");
    await select(session, "beta");
    await own(session, "beta", "repository", "revocation-does-not-retarget-other-agent");
    const id = session.sessionId;
    stopObserve();
    await session.disconnect();
    session = await client.resumeSession(id, config);
    await select(session, "beta");
    await own(session, "beta", "repository", "warm-resume-stable");
    await select(session, "alpha");
    check("warm-resume-revocation-persists", (await call(session, "alpha")).diagnostic.code === "REVOKED_BINDING");
    await session.disconnect();
    assert.equal((await client.stop()).length, 0);
    client = createClient();
    await client.start();
    session = await client.resumeSession(id, config);
    await select(session, "beta");
    await own(session, "beta", "repository", "cold-resume-stable");
    await select(session, "alpha");
    check("cold-resume-revocation-persists", (await call(session, "alpha")).diagnostic.code === "REVOKED_BINDING");
    await session.disconnect();

    stage = "unknown-launch-binding";
    const unknownConfig: SessionConfig = {
      ...config, agent: "foreground",
      customAgents: [{
        name: "foreground", prompt: "Synthetic invalid binding fixture.",
        tools: [wireName("foreground")],
        mcpServers: {
          memory_foreground_repository: bindingLaunch({
            ...reference(wireName("foreground")), fingerprint: "0".repeat(64),
          }),
        },
      }],
    };
    session = await client.createSession(unknownConfig);
    await select(session, "foreground");
    const unknown = await call(session, "foreground");
    check("tampered-launch-reference-denies", unknown.diagnostic.code === "STALE_BINDING" &&
      !Object.hasOwn(unknown.diagnostic, "identity"));
    await session.disconnect();
    check("provider-no-failures", provider.counts().failures === 0);
    stage = "complete";
    passed = true;
  } catch (error) {
    failureCode = error instanceof Error && /^[A-Z_:-]+$/.test(error.message) ? error.message
      : isRecord(error) && typeof error.code === "number" ? String(error.code) : "GATE_ASSERTION_FAILED";
    throw new Error(`PRODUCTION_GATE_ERROR:${stage}:${failureCode}`);
  } finally {
    const cleanup = await client.stop();
    await provider.close();
    const report = {
      schemaVersion: 1, cliVersion: "1.0.83", sdkVersion: "1.0.13",
      platform: `${process.platform}-${process.arch}`,
      identityGate: passed && cleanup.length === 0 ? "PASS" : "NO-GO",
      stage, failureCode, cases, provider: provider.counts(), cleanupErrors: cleanup.length,
      architecture: "Explicit per-definition MCP bindings; no caller-name inference.",
      limits: "No storage, profile edits, installer, remote definitions or OS sandbox certification.",
    };
    await mkdir("test-results", { recursive: true });
    await writeFile("test-results/production-bindings.json", `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PRODUCTION_BINDING_GATE ${JSON.stringify(report)}`);
    await f.close();
    assert.equal(cleanup.length, 0, "CLEANUP_FAILED");
  }
});
