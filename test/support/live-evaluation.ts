import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { approveAll, CopilotClient, RuntimeConnection, ToolSet } from "@github/copilot-sdk";
import type { CopilotSession, SessionConfig } from "@github/copilot-sdk";
import { acceptance, corpus, distribution, followupPrompts, LiveBudget, marker, projects, recallPrompt, roles, saveMarker, savePrompt } from "../../src/evaluation.js";
import type { Role } from "../../src/evaluation.js";
import { registerBinding, loadBinding } from "../../src/binding-registry.js";
import type { BindingReference } from "../../src/binding-registry.js";
import { MemoryStore } from "../../src/memory-store.js";
import { enroll } from "../../src/enrollment.js";
import { SEARCH_TOOL, SAVE_TOOL, saveSchema } from "../../src/memory-protocol.js";
import { isRecord } from "../../src/identity.js";
import { main as prepareSemantic } from "../../src/semantic-cli.js";
import { rebuildIndex } from "../../src/semantic-index.js";
import { createProductionFixture } from "./production-fixture.js";

export async function liveMain(args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: {
    authorize: { type: "boolean" }, "token-stdin": { type: "boolean" }, probe: { type: "boolean" },
    "diagnose-save": { type: "boolean" },
    report: { type: "string", default: "test-results/live-evaluation.json" },
  } });
  const { config, hash } = await acceptance();
  const report: Record<string, unknown> = {
    version: 1, contractHash: hash, model: config.model, effort: config.effort,
    status: "unvalidated", limits: config.limits, startedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
  async function publish() {
    const path = values.report!;
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  }
  if (!values.probe && !values.authorize) {
    report.reason = "EXPLICIT_LIVE_AUTHORIZATION_REQUIRED"; await publish(); return report;
  }
  let token = process.env.COPILOT_GITHUB_TOKEN;
  if (values["token-stdin"]) {
    let input = "";
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (input.length > 16_384) throw new Error("AUTH_INPUT_OVERSIZED");
    }
    token = input.trim();
  }
  if (!token) { report.reason = "COPILOT_CREDENTIAL_UNAVAILABLE"; await publish(); return report; }
  const f = await createProductionFixture();
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: fileURLToPath(new URL("../../../node_modules/.bin/copilot", import.meta.url)) }),
    mode: "empty", workingDirectory: f.repository, baseDirectory: f.config, env: f.env,
    gitHubToken: token, useLoggedInUser: false, logLevel: "none",
  });
  token = undefined;
  const budget = new LiveBudget(config.limits);
  const started = performance.now();
  let current: CopilotSession | undefined;
  let stopReason: string | undefined;
  let usageMissingModel = false;
  const timings: number[] = [], modelTimings: number[] = [], toolTimings: number[] = [];
  const roleTimings = { foreground: { trial: [] as number[], model: [] as number[], tool: [] as number[] },
    helper: { trial: [] as number[], model: [] as number[], tool: [] as number[] } };
  const retrievalModes: Record<string, number> = {};
  const saveDiagnostics: { role: Role; index: number; added: number; matching: number;
    userEvidence: number; unchanged: boolean; attempts: number; outcomes: Record<string, number>;
    inputValidation: Record<string, number>; errorFlags: Record<string, number> }[] = [];
  const references = new Map<Role, BindingReference>();
  const sourceIds = new Map<string, string>();
  const stores = new Map<Role, MemoryStore>();
  const measures = Object.fromEntries(roles.map((role) => [role, {
    recall: 0, baseline: 0, searched: 0, retrieved: 0, saved: 0, unknown: 0, leaks: 0,
    recallSamples: 0, baselineSamples: 0, saveSamples: 0, failures: 0, followup: 0, attempted: 0, completed: 0,
  }])) as Record<Role, {
    recall: number; baseline: number; searched: number; retrieved: number; saved: number; unknown: number;
    leaks: number; recallSamples: number; baselineSamples: number; saveSamples: number; failures: number;
    followup: number; attempted: number; completed: number;
  }>;
  async function abort(reason: string) {
    stopReason ??= reason;
    if (current) await current.abort().catch(() => { stopReason = "LIVE_ABORT_FAILED"; });
  }
  const watchdog = setTimeout(() => { void abort("LIVE_RUN_DEADLINE"); void client.stop(); }, config.limits.runMs);
  const failures: string[] = [];
  let stage = "baseline";
  const sessionConfig = (enabled: boolean, role: Role): SessionConfig => ({
    workingDirectory: f.repository, configDirectory: f.config,
    enableConfigDiscovery: true, customAgentsLocalOnly: true, requestExtensions: enabled, enableExperimentalMode: true, enableManagedSettings: false,
    extensionSdkPath: fileURLToPath(new URL(".", import.meta.resolve("@github/copilot-sdk"))),
    model: config.model, reasoningEffort: config.effort,
    capi: { enableWebSocketResponses: false },
    availableTools: enabled ? new ToolSet().addMcp("*").addBuiltIn("task")
      : role === "helper" ? new ToolSet().addBuiltIn("task") : new ToolSet(),
    agent: enabled ? "eval-foreground" : "baseline-foreground",
    onPermissionRequest: approveAll,
    infiniteSessions: { enabled: false },
    hooks: { onSessionStart() { /* Explicit public root-hook capability on create/resume. */ } },
  });
  async function trial(role: Role, enabled: boolean, prompt: string | string[], expected?: string) {
    if (stopReason || performance.now() - started >= config.limits.runMs) throw new Error("LIVE_RUN_STOPPED");
    budget.admit();
    measures[role].attempted++;
    const session = await client.createSession(sessionConfig(enabled, role)).catch((error: unknown) => {
      measures[role].failures++; throw error;
    });
    current = session;
    let turns = 0, searchCalls = 0, saveCalls = 0, hit = false, leaked = false, answeredBeforeSearch = false;
    const saveOutcomes: Record<string, number> = {};
    const inputValidation: Record<string, number> = {}, errorFlags: Record<string, number> = {};
    let answer = "";
    const observed = new Set<string>();
    const usage = new Set<string>();
    const pending = new Set<string>();
    const starts = new Map<string, { time: number; name: string }>();
    const foreign = roles.filter((item) => item !== role).flatMap((item) => projects.flatMap((_, i) => [marker(item, i), saveMarker(item, i)]));
    const unsubscribe = session.on((event) => {
      if (observed.has(event.id)) return;
      observed.add(event.id);
      if (event.type === "assistant.turn_start") {
        turns++;
        if (turns > config.limits.callsPerTrial || budget.exhausted()) void abort("LIVE_CALL_CAP");
      }
      if (event.type === "assistant.usage") {
        usage.add(event.data.apiCallId ?? event.id);
        budget.record(event.data.apiCallId ?? event.id, {
          ...(event.data.inputTokens === undefined ? {} : { inputTokens: event.data.inputTokens }),
          ...(event.data.outputTokens === undefined ? {} : { outputTokens: event.data.outputTokens }),
          ...(event.data.copilotUsage?.totalNanoAiu === undefined ? {} : { nanoAiu: event.data.copilotUsage.totalNanoAiu }),
        });
        if (event.data.model !== config.model) usageMissingModel = true;
        if (event.data.duration !== undefined) {
          modelTimings.push(event.data.duration); roleTimings[role].model.push(event.data.duration);
        }
        if (budget.exhausted() || budget.missingUsage) void abort("LIVE_COST_OR_USAGE_CAP");
      }
      if (event.type === "tool.execution_start") {
        starts.set(event.data.toolCallId, { time: performance.now(), name: event.data.toolName });
        pending.add(event.data.toolCallId);
        if (event.data.toolName.endsWith(SEARCH_TOOL)) searchCalls++;
        if (event.data.toolName.endsWith(SAVE_TOOL)) {
          saveCalls++;
          const parsed = saveSchema.safeParse(event.data.arguments);
          const allowed = new Set(["action", "operationId", "note", "content", "kind", "status", "evidence",
            "reference", "type", "value", "sourceAt", "confirmedAt", "recordId", "expectedRevision"]);
          const flags = parsed.success ? ["valid"] : parsed.error.issues.map((issue) =>
            `${issue.code}:${issue.path.map((part) => typeof part === "number" ? "item" : allowed.has(String(part)) ? String(part) : "field").join(".")}`);
          for (const flag of flags) inputValidation[flag] = (inputValidation[flag] ?? 0) + 1;
        }
      }
      if (event.type === "tool.execution_complete") {
        const start = starts.get(event.data.toolCallId);
        pending.delete(event.data.toolCallId);
        if (start !== undefined) {
          const elapsed = performance.now() - start.time;
          toolTimings.push(elapsed); roleTimings[role].tool.push(elapsed);
        }
        const text = event.data.result?.content ?? "";
        if (start?.name.endsWith(SAVE_TOOL)) {
          const failure = event.data.error?.message ?? text;
          for (const word of ["schema", "required", "additional", "invalid", "validation", "evidence", "note", "operationId", "permission", "unknown"]) {
            if (failure.toLowerCase().includes(word.toLowerCase())) errorFlags[word] = (errorFlags[word] ?? 0) + 1;
          }
          let outcome = "unstructured";
          try {
            const parsed: unknown = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
            if (isRecord(parsed) && typeof parsed.status === "string") {
              outcome = ["committed", "save_failed", "outcome_unknown", "unavailable"].includes(parsed.status) ? parsed.status : "other";
              if (typeof parsed.code === "string" && /^[A-Z_]+$/.test(parsed.code)) outcome += `:${parsed.code}`;
            }
          } catch { /* Invalid tool output is not a save acknowledgement. */ }
          saveOutcomes[outcome] = (saveOutcomes[outcome] ?? 0) + 1;
        }
        if (start?.name.endsWith(SEARCH_TOOL)) {
          if (foreign.some((value) => text.includes(value))) leaked = true;
          try {
            const parsed: unknown = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
            if (isRecord(parsed) && isRecord(parsed.retrieval) && typeof parsed.retrieval.mode === "string") {
              const mode = parsed.retrieval.mode === "hybrid" ? "hybrid" : "keyword";
              retrievalModes[mode] = (retrievalModes[mode] ?? 0) + 1;
            }
            if (expected && isRecord(parsed) && Array.isArray(parsed.snippets) &&
                parsed.snippets.some((item: unknown) => isRecord(item) && item.recordId === sourceIds.get(expected) &&
                  typeof item.content === "string" && item.content.includes(expected))) hit = true;
          } catch { /* Unstructured tool errors cannot qualify as retrieved evidence. */ }
        }
      }
      if (event.type === "assistant.message" &&
          ((role === "helper" && event.agentId !== undefined) || (role === "foreground" && event.agentId === undefined))) {
        answer = event.data.content;
        if (!searchCalls && ((expected && answer.includes(expected)) || answer.includes("UNKNOWN"))) answeredBeforeSearch = true;
      }
    });
    const timer = setTimeout(() => { void abort("LIVE_TRIAL_DEADLINE"); }, config.limits.trialMs);
    const start = performance.now();
    try {
      await session.rpc.tools.initializeAndValidate();
      if (role === "foreground") {
        for (const message of typeof prompt === "string" ? [prompt] : prompt) {
          await session.sendAndWait({ prompt: message }, config.limits.trialMs);
        }
      }
      else {
        const result = await session.rpc.tools.execute({ name: "task", arguments: {
          agent_type: enabled ? "eval-helper" : "baseline-helper", name: "evaluation-helper",
          description: "Synthetic memory evaluation", prompt: typeof prompt === "string" ? prompt : prompt.join("\nFollow-up: "), mode: "sync",
        } });
        if (typeof result !== "string" && result.resultType !== "success") throw new Error("LIVE_HELPER_FAILED");
      }
      const drainDeadline = performance.now() + 5_000;
      while ((usage.size < turns || pending.size || !answer) && performance.now() < drainDeadline && !stopReason) await delay(25);
      if (stopReason || !answer || !turns) throw new Error(stopReason ?? "LIVE_RESPONSE_MISSING");
      if (usage.size < turns || pending.size) throw new Error("LIVE_TELEMETRY_INCOMPLETE");
      if (foreign.some((value) => answer.includes(value))) leaked = true;
      measures[role].completed++;
      return { correct: expected ? answer.includes(expected) : answer.trim().toUpperCase().includes("UNKNOWN"),
        searched: searchCalls > 0 && !answeredBeforeSearch, retrieved: hit, leaked, saveCalls, saveOutcomes, inputValidation, errorFlags };
    } catch (error) {
      measures[role].failures++; throw error;
    } finally {
      const elapsed = performance.now() - start;
      timings.push(elapsed); roleTimings[role].trial.push(elapsed);
      clearTimeout(timer); unsubscribe();
      await session.disconnect(); current = undefined;
    }
  }
  try {
    await client.start();
    const auth = await client.getAuthStatus();
    const status = await client.getStatus();
    const models = await client.listModels();
    const sdk: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.resolve("@github/copilot-sdk")), "utf8"));
    const sdkMatches = isRecord(sdk) && sdk.version === config.host.sdk;
    const selected = models.find((model) => model.id === config.model);
    if (status.version !== config.host.cli || !sdkMatches || !auth.isAuthenticated || !selected ||
        !selected.supportedReasoningEfforts?.includes(config.effort)) {
      report.reason = "LIVE_BASELINE_UNAVAILABLE";
      report.baseline = { cliMatches: status.version === config.host.cli, sdkMatches, authenticated: auth.isAuthenticated,
        modelAvailable: Boolean(selected), effortAvailable: selected?.supportedReasoningEfforts?.includes(config.effort) ?? false };
      return report;
    }
    report.baseline = { cli: status.version, sdk: config.host.sdk, model: selected.id, effort: config.effort, billing: selected.billing };
    if (values.probe) { report.status = "probe_ready"; return report; }
    if (process.platform !== config.host.platform || process.arch !== config.host.arch ||
        process.version !== `v${config.host.node}` || !process.env.PINOCCHIO_TEST_PYTHON) {
      report.reason = "LIVE_ENVIRONMENT_MISMATCH"; return report;
    }
    stage = "semantic-prepare";
    await prepareSemantic(["prepare", "--config-root", f.config, "--python", process.env.PINOCCHIO_TEST_PYTHON]);
    for (const role of roles) {
      stage = `seed-${role}`;
      const directory = role === "foreground" ? join(f.repository, ".github", "agents") : join(f.config, "agents");
      await mkdir(directory, { recursive: true });
      const path = join(directory, `eval-${role}.agent.md`);
      const instruction = "Use only your configured tools. Do not delegate. Answer project questions only from supported information; otherwise answer UNKNOWN.";
      await writeFile(path, `---\nname: eval-${role}\ndescription: Synthetic release evaluation\ntools: [${role === "foreground" ? "task" : ""}]\nmodel: ${config.model}\nreasoning-effort: ${config.effort}\n---\n${instruction}\n`);
      const reference = await registerBinding({
        configRoot: f.config, definitionPath: path, origin: role === "foreground" ? "project" : "user",
        originRoot: directory, scope: { kind: "repository", root: f.repository },
      });
      references.set(role, reference);
      await enroll(reference, true);
      const binding = await loadBinding(reference);
      const store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: "repository" });
      stores.set(role, store);
      for (const [index, content] of corpus(role, config.corpusPerNamespace).entries()) {
        const saved = await store.remember({ content, kind: "decision", evidence: [
          { kind: "user_statement", reference: { type: "text", value: "synthetic project decision" } },
        ] }, `seed-${index}`);
        if (index < projects.length && saved.recordId) sourceIds.set(marker(role, index), saved.recordId);
      }
      await rebuildIndex(reference);
      await writeFile(join(directory, `baseline-${role}.agent.md`),
        `---\nname: baseline-${role}\ndescription: Synthetic no-memory control\ntools: [${role === "foreground" ? "task" : ""}]\nmodel: ${config.model}\nreasoning-effort: ${config.effort}\n---\n${instruction}\n`);
    }
    for (const role of roles) {
      stage = `evaluate-${role}`;
      const totals = measures[role];
      for (let i = 0; i < (values["diagnose-save"] ? 0 : config.recallSamplesPerRole); i++) {
        for (const enabled of i % 2 ? [true, false] : [false, true]) {
          const result = await trial(role, enabled, recallPrompt(i), marker(role, i));
          if (enabled) {
            totals.recallSamples++; totals.recall += Number(result.correct);
            totals.searched += Number(result.searched); totals.retrieved += Number(result.retrieved);
          } else { totals.baselineSamples++; totals.baseline += Number(result.correct); }
          totals.leaks += Number(result.leaked);
        }
      }
      const store = stores.get(role)!;
      for (let i = 0; i < (values["diagnose-save"] ? 1 : config.saveSamplesPerRole); i++) {
        const original = await store.indexMetadata();
        const before = new Set(original.map((item) => item.id));
        const result = await trial(role, true, savePrompt(role, i));
        totals.leaks += Number(result.leaked);
        const after = await store.indexMetadata();
        const unchanged = original.every((item) => after.some((other) => item.id === other.id && item.revision === other.revision));
        const added = (await store.list({ limit: 100, offset: 0 })).items.filter((item) => !before.has(item.id));
        saveDiagnostics.push({ role, index: i, added: added.length, unchanged,
          matching: added.filter((item) => item.content.includes(saveMarker(role, i))).length,
          userEvidence: added.filter((item) => JSON.stringify(item.evidence).includes("user_statement")).length,
          attempts: result.saveCalls, outcomes: result.saveOutcomes, inputValidation: result.inputValidation, errorFlags: result.errorFlags });
        totals.saveSamples++;
        if (unchanged && added.length === 1 && added[0]!.content.includes(saveMarker(role, i)) &&
            JSON.stringify(added[0]!.evidence).includes("user_statement")) totals.saved++;
      }
      if (values["diagnose-save"]) continue;
      const unknown = await trial(role, true, "What is the approved release marker for Project Unrecorded? Answer with its marker if supported, otherwise UNKNOWN.");
      totals.unknown = Number(unknown.correct); totals.leaks += Number(unknown.leaked);
      const followup = await trial(role, true, followupPrompts, marker(role, 0));
      totals.followup = Number(followup.correct); totals.leaks += Number(followup.leaked);
    }
    const verdicts = roles.map((role) => {
      const m = measures[role], n = config.recallSamplesPerRole;
      const pass = m.recallSamples === n && m.baselineSamples === n && m.saveSamples === config.saveSamplesPerRole &&
        m.searched / n >= config.thresholds.searchCompliance && m.retrieved / n >= config.thresholds.scopedRetrieval &&
        m.saved / config.saveSamplesPerRole >= config.thresholds.saveQuality &&
        (m.recall - m.baseline) / n >= config.thresholds.answerBenefit &&
        m.leaks === 0 && m.unknown === config.thresholds.unknownAnswers && m.followup === config.followupSamplesPerRole;
      return { role, pass, ...m };
    });
    report.roles = verdicts;
    report.status = values["diagnose-save"] ? "diagnostic" :
      verdicts.every((item) => item.pass) && !usageMissingModel && !budget.missingUsage && !budget.exhausted() ? "pass" : "fail";
    if (usageMissingModel) failures.push("LIVE_MODEL_ID_MISMATCH");
  } catch (error) {
    report.status = budget.calls ? "fail" : "unvalidated";
    report.failedStage = stage;
    failures.push(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "LIVE_RUN_FAILED");
  } finally {
    clearTimeout(watchdog);
    report.roles ??= roles.map((role) => ({ role, pass: false, ...measures[role] }));
    report.usage = budget.summary(); report.failures = failures;
    report.latency = { trialMs: distribution(timings), modelMs: distribution(modelTimings), toolMs: distribution(toolTimings) };
    report.roleLatency = roles.map((role) => ({ role, trialMs: distribution(roleTimings[role].trial),
      modelMs: distribution(roleTimings[role].model), toolMs: distribution(roleTimings[role].tool) }));
    report.retrievalModes = retrievalModes;
    report.saveDiagnostics = saveDiagnostics;
    report.omissions = roles.map((role) => ({ role, trials: config.recallSamplesPerRole * 2 +
      config.saveSamplesPerRole + config.unknownSamplesPerRole + config.followupSamplesPerRole - measures[role].completed }));
    report.finishedAt = new Date().toISOString();
    await client.stop();
    for (const store of stores.values()) store.close();
    await f.close();
    await publish();
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await liveMain(process.argv.slice(2));
    process.stdout.write(JSON.stringify(report) + "\n");
    process.exitCode = report.status === "pass" || report.status === "probe_ready" ? 0 : 2;
  } catch {
    process.stderr.write("LIVE_EVALUATION_FAILED\n"); process.exitCode = 1;
  }
}
