import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { registerBinding, loadBinding } from "./binding-registry.js";
import { enroll } from "./enrollment.js";
import { memoryLaunch } from "./memory-mcp.js";
import { MemoryStore } from "./memory-store.js";
import { SEARCH_TOOL, SAVE_TOOL, ToolError } from "./memory-protocol.js";
import { startSyntheticProvider } from "../test/support/provider.js";
import { PUBLIC_HOST, PUBLIC_NODE, releaseRoot } from "./release.js";

const execute = promisify(execFile);
export const installedHost = join(releaseRoot, "node_modules", ".bin", "copilot");

export async function prerequisites(previewPlatform = false) {
  if (process.versions.node !== PUBLIC_NODE) throw new ToolError("NODE_22_18_0_REQUIRED");
  const supported = process.platform === "linux" && process.arch === "x64";
  if (!supported && !(previewPlatform && process.platform === "darwin")) throw new ToolError("PLATFORM_UNVALIDATED");
  const version = await execute(installedHost, ["--version"], { timeout: 15_000, maxBuffer: 4096 });
  if (!new RegExp(`CLI ${PUBLIC_HOST.replaceAll(".", "\\.")}(?:\\.|\\s|$)`).test(version.stdout)) {
    throw new ToolError("PINNED_CLI_REQUIRED");
  }
  return { cli: PUBLIC_HOST, node: PUBLIC_NODE, platform: process.platform, arch: process.arch,
    platformCertification: supported ? "synthetic-baseline" : "unvalidated-preview" };
}

/** No account, real profiles, model inference or user memory enters this diagnostic. */
export async function diagnose(previewPlatform = false) {
  const host = await prerequisites(previewPlatform);
  const root = await mkdtemp(join(tmpdir(), "pinocchio-install-check-"));
  const home = join(root, "home");
  const config = join(home, "custom-config");
  const repository = join(root, "repository");
  const cases: string[] = [];
  let stage = "setup";
  const launches = new Map<string, ReturnType<typeof memoryLaunch>>();
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
    selectTool(messages) {
      const t = target(messages);
      if (t.delegate) return "task";
      const launch = launches.get(t.name);
      assert.ok(launch);
      return `${launch.serverName}-${t.save ? SAVE_TOOL : SEARCH_TOOL}`;
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
    await mkdir(join(config, "agents"), { recursive: true, mode: 0o700 });
    await mkdir(repository, { mode: 0o700 });
    await execute("git", ["init", "--quiet", "--initial-branch=main", repository], { env });
    const references = [];
    for (const name of ["check-main", "check-helper"]) {
      const path = join(config, "agents", `${name}.agent.md`);
      await writeFile(path, `---\nname: ${name}\ndescription: Synthetic installation check\ntools: [view, task]\n---\nUse your scoped tools.\n`);
      const ref = await registerBinding({ configRoot: config, definitionPath: path, origin: "user",
        originRoot: join(config, "agents"), scope: { kind: "repository", root: repository } });
      await enroll(ref);
      references.push(ref);
      launches.set(name, memoryLaunch(ref));
    }
    cases.push("tools-verified-before-enrollment");
    async function turn(prompt: string, expected: string, absent?: string) {
      stage = prompt;
      observed.length = 0;
      await execute(installedHost, ["--experimental", "--no-auto-update",
        "--extension-sdk-path", fileURLToPath(new URL(".", import.meta.resolve("@github/copilot-sdk"))),
        "--agent", "check-main", "--allow-tool", "task",
        ...[...launches.values()].flatMap((launch) =>
          [SEARCH_TOOL, SAVE_TOOL].flatMap((tool) => ["--allow-tool", `${launch.serverName}(${tool})`])),
        "-p", prompt], { cwd: repository, env, timeout: 45_000, maxBuffer: 1024 * 1024 });
      const results = observed.join("\n");
      assert.ok(results.includes(expected), "EXPECTED_SYNTHETIC_TOOL_RESULT_MISSING");
      if (absent) assert.ok(!results.includes(absent), "CROSS_SCOPE_SYNTHETIC_RESULT");
      cases.push(prompt.toLowerCase().replaceAll(" ", "-"));
    }
    await turn("FOREGROUND SAVE", "committed");
    await turn("DELEGATE SAVE", "committed");
    await turn("FOREGROUND SEARCH", "synthetic memory marker check-main", "synthetic memory marker check-helper");
    await turn("DELEGATE SEARCH", "synthetic memory marker check-helper", "synthetic memory marker check-main");
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
    await turn("FOREGROUND SEARCH DELETED", '"snippets":[]');
    await turn("DELEGATE SEARCH DELETED", '"snippets":[]');
    assert.equal(provider.counts().failures, 0);
    return { status: "passed", host, cases, sessions: 6, syntheticOnly: true,
      liveCertification: "unvalidated", desktop: "unvalidated" };
  } catch (error) {
    const toolCode = /"code"\s*:\s*"([A-Z_]+)"/.exec(observed.join("\n"))?.[1];
    const providerCode = provider.counts().failureCodes[0];
    const reason = toolCode ?? providerCode ??
      (error instanceof Error && error.message === "EXPECTED_SYNTHETIC_TOOL_RESULT_MISSING" ? "RESULT_MISSING" : "HOST_CALL_FAILED");
    throw new ToolError(`INSTALL_DIAGNOSTIC_FAILED_${stage.replaceAll(" ", "_")}_${reason}`);
  } finally {
    try { await provider.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}
