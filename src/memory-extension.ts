import { joinSession } from "@github/copilot-sdk/extension";
import { basename } from "node:path";
import { canonicalRepository, configRootPath, fingerprint, loadBinding } from "./binding-registry.js";
import { createMemoryHooks } from "./memory-hooks.js";
import { isRecord } from "./identity.js";
import { captureConversation, conversationOwner } from "./conversation-memory.js";
import type { ConversationOwner } from "./conversation-memory.js";
import { extensionSaveInputSchema, EXTENSION_SAVE_TOOL, EXTENSION_SEARCH_TOOL, SAVE_TOOL, SEARCH_TOOL, searchSchema, searchDescription, ToolError } from "./memory-protocol.js";
import {
  CloudJobsError,
  checkCloudJobResultNotices,
  discoverCloudJobs,
  formatCloudJobResultNotices,
  markCloudJobResultNotices,
  releaseCloudJobResultNotices,
  startOwnerCloudJobDriftMonitor,
} from "./cloud-jobs.js";
import { JOBS_TOOL, extensionJobsToolInputSchema, handleJobsTool } from "./jobs.js";
import type { CloudJobResultNoticeResult } from "./cloud-jobs.js";
import { z } from "zod";
import { BroadcastListener, BROADCAST_HEARTBEAT_MS, broadcastCode, broadcastRuntimeVersion } from "./broadcast.js";
import { JobsStore } from "./jobs-store.js";
import { LocalJobs } from "./local-jobs.js";

const configRoot = configRootPath();
const loadedRuntime = await broadcastRuntimeVersion();
const jobsStore = await JobsStore.open(configRoot);
let session: Awaited<ReturnType<typeof joinSession>> | undefined;
let localJobs: LocalJobs | undefined;
let pending = Promise.resolve();
let queued = 0;
let generation = 0;
let directory = process.cwd();
let captureFailure = false;
let previousUser = "";
let previousOwner = "";
let pendingCloudResults: CloudJobResultNoticeResult | undefined;
let cloudResultCompletion: Promise<void> | undefined;
let checkingCloudResults = false;
let skipNextAssistantCapture = false;
const subagentOwners = new Map<string, Promise<ConversationOwner | undefined>>();
const pendingSubagentOwners = new Map<string, {
  promise: Promise<ConversationOwner | undefined>;
  resolve: (owner: ConversationOwner | PromiseLike<ConversationOwner | undefined> | undefined) => void;
  timer: NodeJS.Timeout;
}>();
const toolOwners = new Map<string, Promise<ConversationOwner | undefined>>();
const subagentToolCalls = new Set<string>();
let broadcastChecking = false;
let broadcastStopped = false;
let broadcastWarning = "";
let broadcastIssue: { key: string; since: number } | undefined;
let broadcastRecoveryKey = "";
let jobsInventoryVersion = "";
let cloudMonitorOwner = "";
let stopCloudMonitor = () => {};
let cloudInventoryOwner = "";
let cloudInventoryVersion = "";
let deliveredCloudInventoryVersion = "";
let cloudInventoryText = "";
let cloudInventoryRefresh: Promise<void> | undefined;
let cloudInventoryRefreshOwner = "";
let cloudInventoryRefreshGeneration = 0;
const CLOUD_RESULT_DISPLAY_PROMPT = "Pinocchio found new cloud job results";
let cloudStatus: Awaited<ReturnType<typeof import("./cloud-jobs.js").checkOwnerCloudJobDrift>> | {
  status: "unavailable"; code: string;
} | undefined;
function refreshCloudInventory(owner: ConversationOwner, force = false) {
  const ownerId = owner.reference.bindingId;
  if (!force && cloudInventoryRefresh &&
      cloudInventoryRefreshOwner === ownerId) {
    return cloudInventoryRefresh;
  }
  const refreshGeneration = ++cloudInventoryRefreshGeneration;
  const refresh = discoverCloudJobs(owner.reference).then((result) => {
    if (cloudMonitorOwner !== ownerId ||
        refreshGeneration !== cloudInventoryRefreshGeneration) return;
    cloudInventoryOwner = ownerId;
    cloudInventoryText = [
      "Pinocchio cloud jobs inventory (authoritative remote records):",
      ...result.jobs.map((job) =>
        `- cloud ${job.id} [${job.repository}]: ${job.enabled ? "enabled" : "paused"}, ${job.cron} ${job.timezone}`),
      ...result.sources
        .filter((source) => source.status === "unavailable")
        .map((source) =>
          `- unavailable source ${source.repository}: ${source.code}`),
      "Use pinocchio_jobs for current inspection, history, results, changes, run-now, or cancellation.",
      "",
    ].join("\n");
    cloudInventoryVersion = fingerprint(JSON.stringify({
      owner: ownerId,
      inventory: cloudInventoryText,
    }));
  }, (error: unknown) => {
    if (cloudMonitorOwner !== ownerId ||
        refreshGeneration !== cloudInventoryRefreshGeneration) return;
    cloudInventoryOwner = ownerId;
    const code = error instanceof CloudJobsError
      ? error.code
      : "CLOUD_JOB_DISCOVERY_FAILED";
    cloudInventoryText =
      `Pinocchio cloud jobs inventory is unavailable (${code}); do not report an empty inventory.\n`;
    cloudInventoryVersion = fingerprint(cloudInventoryText);
  }).finally(() => {
    if (cloudInventoryRefresh === refresh) {
      cloudInventoryRefresh = undefined;
      cloudInventoryRefreshOwner = "";
    }
  });
  cloudInventoryRefresh = refresh;
  cloudInventoryRefreshOwner = ownerId;
  return refresh;
}
function activateJobsOwner(
  owner: ConversationOwner,
  agentName: string,
) {
  localJobs?.setActiveOwner(owner.reference, agentName);
  if (cloudMonitorOwner === owner.reference.bindingId) return;
  stopCloudMonitor();
  cloudMonitorOwner = owner.reference.bindingId;
  cloudStatus = undefined;
  void refreshCloudInventory(owner, true);
  stopCloudMonitor = startOwnerCloudJobDriftMonitor(
    owner.reference,
    (result) => { cloudStatus = result; },
  );
}
async function selectedOwner() {
  if (!session) return;
  return conversationOwner(configRoot, await session.rpc.agent.getCurrent());
}
async function ownerForAgent(name: string) {
  if (!session) return;
  const matches = (await session.rpc.agent.list()).agents.filter(
    (agent) => agent.name === name || agent.id === name,
  );
  if (matches.length !== 1) return;
  return conversationOwner(configRoot, { agent: matches[0] });
}
async function ownerForSession(sessionId: string) {
  if (!session) return;
  if (sessionId === session.sessionId) return selectedOwner();
  return ownerForSubagent(sessionId);
}
function ownerForSubagent(agentId: string) {
  const known = subagentOwners.get(agentId);
  if (known) return known;
  const pendingOwner = pendingSubagentOwners.get(agentId);
  if (pendingOwner) return pendingOwner.promise;
  let resolveOwner!: (
    owner: ConversationOwner | PromiseLike<ConversationOwner | undefined> | undefined,
  ) => void;
  const promise = new Promise<ConversationOwner | undefined>((resolve) => {
    resolveOwner = resolve;
  });
  const timer = setTimeout(() => {
    const pending = pendingSubagentOwners.get(agentId);
    if (pending?.promise !== promise) return;
    pendingSubagentOwners.delete(agentId);
    resolveOwner(undefined);
  }, 1_000);
  timer.unref();
  pendingSubagentOwners.set(agentId, { promise, resolve: resolveOwner, timer });
  return promise;
}
function registerSubagentOwner(
  agentId: string,
  owner: Promise<ConversationOwner | undefined>,
) {
  subagentOwners.set(agentId, owner);
  const pendingOwner = pendingSubagentOwners.get(agentId);
  if (!pendingOwner) return;
  clearTimeout(pendingOwner.timer);
  pendingSubagentOwners.delete(agentId);
  pendingOwner.resolve(owner);
}
function releaseSubagentOwner(agentId: string) {
  subagentOwners.delete(agentId);
  const pendingOwner = pendingSubagentOwners.get(agentId);
  if (!pendingOwner) return;
  clearTimeout(pendingOwner.timer);
  pendingSubagentOwners.delete(agentId);
  pendingOwner.resolve(undefined);
}
async function ownerForTool(toolCallId: string) {
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (toolOwners.has(toolCallId)) return toolOwners.get(toolCallId);
  if (subagentOwners.size) return;
  return selectedOwner();
}
const context = createMemoryHooks(configRoot, async (input) => {
  directory = input.workingDirectory;
  await pending;
  if (!session) return;
  const owner = await ownerForSession(input.sessionId);
  if (!owner) return;
  const current = await session.rpc.agent.getCurrent();
  const agentName = current.agent?.path
    ? basename(current.agent.path, ".agent.md")
    : current.agent?.name ?? "";
  activateJobsOwner(owner, agentName);
  const recalled = await context.recall(owner, {
    sessionId: input.sessionId, directory: input.workingDirectory, prompt: input.prompt,
  });
  const inventoryVersion = jobsStore.inventoryVersion(owner.reference.bindingId);
  const inventory = inventoryVersion !== jobsInventoryVersion
    ? localJobs?.inventoryContext(owner.reference) ?? ""
    : "";
  jobsInventoryVersion = inventoryVersion;
  const cloudInventory = cloudInventoryOwner === owner.reference.bindingId &&
      cloudInventoryVersion &&
      cloudInventoryVersion !== deliveredCloudInventoryVersion
    ? cloudInventoryText
    : "";
  if (cloudInventory) deliveredCloudInventoryVersion = cloudInventoryVersion;
  const cloudNotice = cloudStatus && "drifted" in cloudStatus && cloudStatus.drifted
    ? `Pinocchio jobs: ${cloudStatus.drifted} published cloud snapshot(s) differ from local profiles or need attention. Tell the user and use ${JOBS_TOOL} with action=drift before proposing a sync.\n`
    : cloudStatus?.status === "unavailable"
      ? `Pinocchio cloud job drift checking is unavailable (${
          "code" in cloudStatus
            ? cloudStatus.code
            : cloudStatus.sources
                .map((source) => source.status === "unavailable" ? source.code : undefined)
                .filter(Boolean)
                .join(",") || "CLOUD_DRIFT_CHECK_FAILED"
        }). Tell the user if cloud jobs are relevant to this request.\n`
      : "";
  return `${captureFailure ? "Pinocchio automatic capture failed for an earlier message. Tell the user; do not claim it was saved.\n" : ""}${cloudNotice}${inventory}${cloudInventory}${recalled}`;
});
session = await joinSession({
  hooks: context.hooks,
  tools: [{
    name: "pinocchio_memory_context_status",
    description: "Check the shared memory context service. Diagnostic only; no notes, owners or session identifiers.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    defer: "never",
    async handler(args) {
      if (!isRecord(args) || Reflect.ownKeys(args).length) {
        return { resultType: "failure", textResultForLlm: '{"status":"unavailable","code":"INVALID_ARGUMENTS"}' };
      }
      try {
        const health = await context.health();
        if (!isRecord(health)) throw new Error("INVALID_HEALTH_RESPONSE");
        return { resultType: "success", textResultForLlm: JSON.stringify({
          ...health, conversationCapture: captureFailure ? "failed" : "ready",
        }) };
      } catch {
        return { resultType: "failure", textResultForLlm: '{"status":"unavailable","code":"CONTEXT_UNAVAILABLE"}' };
      }
    },
  }, ...[
    {
      name: EXTENSION_SEARCH_TOOL,
      description: searchDescription,
      parameters: z.toJSONSchema(searchSchema, { io: "input" }),
    },
    {
      name: EXTENSION_SAVE_TOOL,
      description: "Save, correct, or check a memory operation. For remember/correct, note requires content, kind, and at least one evidence item with kind plus reference type/value.",
      parameters: extensionSaveInputSchema,
    },
  ].map((tool) => ({
    ...tool,
    defer: "never" as const,
    async handler(args: unknown, invocation: {
      sessionId: string; toolCallId: string; signal?: AbortSignal;
    }) {
      try {
        if (!session || !directory) throw new ToolError("CONVERSATION_CONTEXT_UNAVAILABLE");
        const owner = await ownerForTool(invocation.toolCallId);
        if (!owner) throw new ToolError("MEMORY_OWNER_UNAVAILABLE");
        const result = await context.call(owner, {
          sessionId: invocation.sessionId, directory, toolCallId: invocation.toolCallId,
          tool: tool.name === EXTENSION_SEARCH_TOOL ? SEARCH_TOOL : SAVE_TOOL,
          arguments: args, ...(invocation.signal ? { signal: invocation.signal } : {}),
        });
        return { resultType: "success" as const, textResultForLlm: JSON.stringify(result) };
      } catch (error) {
        const code = error instanceof ToolError ? error.code : "MEMORY_UNAVAILABLE";
        return {
          resultType: "failure" as const,
          textResultForLlm: JSON.stringify({ status: "unavailable", code }),
          error: code,
        };
      } finally {
        toolOwners.delete(invocation.toolCallId);
      }
    },
  })), {
    name: JOBS_TOOL,
    description:
      "Manage the selected Pinocchio agent's local active-session and GitHub Actions cloud jobs. Consult definitions and run history for scheduling questions. Preview before publishing, and require explicit approval for mutations, run-now, and cancellation.",
    parameters: extensionJobsToolInputSchema,
    defer: "never",
    async handler(args: unknown, invocation) {
      try {
        if (!session) throw new CloudJobsError("CONVERSATION_CONTEXT_UNAVAILABLE");
        if (subagentToolCalls.has(invocation.toolCallId)) {
          throw new CloudJobsError("RECURSIVE_JOB_MANAGEMENT_DENIED");
        }
        const owner = await ownerForTool(invocation.toolCallId);
        if (!owner) throw new CloudJobsError("MEMORY_OWNER_UNAVAILABLE");
        const result = await handleJobsTool(owner.reference, args, undefined, localJobs);
        void refreshCloudInventory(owner);
        if (isRecord(args) && args.action === "latest" &&
            args.includeResult === true && isRecord(result) && "result" in result &&
            typeof result.result === "string") {
          skipNextAssistantCapture = true;
        }
        return { resultType: "success" as const, textResultForLlm: JSON.stringify(result) };
      } catch (error) {
        const code = error instanceof CloudJobsError || error instanceof ToolError
          ? error.code
          : error instanceof z.ZodError
            ? "INVALID_ARGUMENTS"
            : isRecord(error) && typeof error.code === "string"
              ? error.code
            : "CLOUD_JOBS_UNAVAILABLE";
        return {
          resultType: "failure" as const,
          textResultForLlm: JSON.stringify({ status: "unavailable", code }),
          error: code,
        };
      } finally {
        toolOwners.delete(invocation.toolCallId);
        subagentToolCalls.delete(invocation.toolCallId);
      }
    },
  }],
});
localJobs = new LocalJobs(jobsStore, session);
for (const name of ["subagent.started", "subagent.selected"] as const) {
  session.on(name, (event) => {
    if (event.agentId) {
      registerSubagentOwner(event.agentId, ownerForAgent(event.data.agentName));
    }
  });
}
session.on("tool.execution_start", (event) => {
  if ([EXTENSION_SEARCH_TOOL, EXTENSION_SAVE_TOOL, JOBS_TOOL].includes(event.data.toolName)) {
    if (event.agentId) subagentToolCalls.add(event.data.toolCallId);
    toolOwners.set(event.data.toolCallId, event.agentId
      ? ownerForSubagent(event.agentId)
      : selectedOwner());
  }
});
for (const name of ["subagent.completed", "subagent.failed"] as const) {
  session.on(name, (event) => {
    if (event.agentId) {
      void localJobs?.reconcile(event.agentId).catch(() => {
        process.stderr.write("Pinocchio: LOCAL_JOB_RECONCILE_FAILED\n");
      });
      releaseSubagentOwner(event.agentId);
    }
  });
}
const broadcast = new BroadcastListener(configRoot, session.sessionId, loadedRuntime);
async function reportBroadcastIssue(fallbackCode?: string) {
  const issue = broadcast.issue() ?? (fallbackCode
    ? { key: fallbackCode, code: fallbackCode, restartRequired: false } : undefined);
  if (!issue) { broadcastIssue = undefined; broadcastWarning = ""; return; }
  if (broadcastIssue?.key !== issue.key) broadcastIssue = { key: issue.key, since: Date.now() };
  // Tool registration can lag agent selection; don't turn normal startup into a warning.
  if (issue.code === "TOOLS_NOT_AVAILABLE" && Date.now() - broadcastIssue.since < 2 * BROADCAST_HEARTBEAT_MS) return;
  if (broadcastWarning === issue.key) return;
  broadcastWarning = issue.key;
  process.stderr.write(`Pinocchio: ${issue.code}\n`);
  const message = issue.restartRequired
    ? "Pinocchio instruction refresh needs a session restart."
    : "Pinocchio could not refresh this agent's instructions.";
  try {
    await session?.log(`${message} Run npm run broadcast -- status in your Pinocchio checkout for details (${issue.code}).`, { level: "warning" });
  } catch {
    process.stderr.write("Pinocchio: BROADCAST_NOTICE_UNAVAILABLE\n");
  }
}
async function recoverBroadcastIssue(
  active: NonNullable<typeof session>,
  agent: NonNullable<Awaited<ReturnType<typeof active.rpc.agent.getCurrent>>["agent"]>,
  owner: ConversationOwner,
) {
  const issue = broadcast.issue();
  if (!issue) {
    broadcastRecoveryKey = "";
    return false;
  }
  if (broadcastIssue?.key !== issue.key) {
    broadcastIssue = { key: issue.key, since: Date.now() };
  }
  if (broadcastRecoveryKey === issue.key) return false;
  if (issue.code === "RUNTIME_CHANGED") {
    if (!await broadcast.claimRuntimeReload()) return false;
    broadcastRecoveryKey = issue.key;
    await active.rpc.extensions.reload();
    return true;
  }
  const toolsSettled = issue.code !== "TOOLS_NOT_AVAILABLE" ||
    Date.now() - broadcastIssue.since >= 2 * BROADCAST_HEARTBEAT_MS;
  if ((issue.code === "AGENT_SETTINGS_CHANGED" ||
      issue.code === "TOOLS_NOT_AVAILABLE") && toolsSettled) {
    broadcastRecoveryKey = issue.key;
    await active.rpc.agent.reload();
    await active.rpc.agent.select({ name: agent.name });
    await active.rpc.tools.initializeAndValidate();
    await broadcast.agentReloaded(owner.reference);
    return true;
  }
  return false;
}
async function checkBroadcast() {
  if (!session || broadcastChecking || broadcastStopped) return;
  broadcastChecking = true;
  try {
    const active = session;
    const selectedGeneration = generation;
    const current = await active.rpc.agent.getCurrent();
    const agent = current.agent;
    const owner = await conversationOwner(configRoot, current);
    if (!owner || !agent) {
      localJobs?.setActiveOwner(undefined, "");
      stopCloudMonitor();
      stopCloudMonitor = () => {};
      cloudMonitorOwner = "";
      cloudStatus = undefined;
      cloudInventoryOwner = "";
      cloudInventoryVersion = "";
      cloudInventoryText = "";
      cloudInventoryRefreshGeneration++;
      await broadcast.close();
      return;
    }
    activateJobsOwner(
      owner,
      agent.path ? basename(agent.path, ".agent.md") : agent.name,
    );
    await broadcast.heartbeat(owner.reference);
    let metadata = await active.rpc.tools.getCurrentMetadata();
    if (!metadata.tools) return;
    let prompt = await broadcast.prepare(owner.reference, metadata.tools.flatMap((tool) =>
      tool.namespacedName ? [tool.name, tool.namespacedName] : [tool.name]));
    if (!prompt && await recoverBroadcastIssue(active, agent, owner)) {
      metadata = await active.rpc.tools.getCurrentMetadata();
      if (!metadata.tools) return;
      prompt = await broadcast.prepare(owner.reference, metadata.tools.flatMap((tool) =>
        tool.namespacedName ? [tool.name, tool.namespacedName] : [tool.name]));
    }
    if (prompt) {
      const binding = await loadBinding(owner.reference);
      if (binding.scope.kind === "repository" && await canonicalRepository(directory) !== binding.scope.root) {
        throw Object.assign(new Error("BROADCAST_SCOPE_MISMATCH"), { code: "BROADCAST_SCOPE_MISMATCH" });
      }
      if (broadcastStopped || generation !== selectedGeneration) return;
      await active.rpc.agent.setPrompt({ id: agent.id, prompt });
      const selected = await conversationOwner(configRoot, await active.rpc.agent.getCurrent());
      if (broadcastStopped || generation !== selectedGeneration || selected?.reference.bindingId !== owner.reference.bindingId) return;
      await broadcast.acknowledge(owner.reference);
    }
    await reportBroadcastIssue();
  } catch (error) {
    if (broadcastStopped) return;
    await broadcast.failed(error).catch(() => { process.stderr.write("Pinocchio: BROADCAST_STATUS_WRITE_FAILED\n"); });
    await reportBroadcastIssue(broadcastCode(error));
  } finally { broadcastChecking = false; }
}
const broadcastTimer = setInterval(() => { void checkBroadcast(); }, BROADCAST_HEARTBEAT_MS);
broadcastTimer.unref();
void checkBroadcast();
async function completeCloudResultNotice(result: CloudJobResultNoticeResult) {
  if (pendingCloudResults !== result) return;
  if (!cloudResultCompletion) {
    const completion = (async () => {
      await markCloudJobResultNotices(result);
      if (pendingCloudResults === result) pendingCloudResults = undefined;
    })();
    cloudResultCompletion = completion;
    void completion.finally(() => {
      if (cloudResultCompletion === completion) {
        cloudResultCompletion = undefined;
      }
    }).catch(() => {});
  }
  await cloudResultCompletion;
}
async function queueCloudResultNotices() {
  if (!session || checkingCloudResults || pendingCloudResults) return;
  checkingCloudResults = true;
  try {
    const activeSession = session;
    const current = await activeSession.rpc.agent.getCurrent();
    const owner = await conversationOwner(configRoot, current);
    if (!owner) return;
    const result = await checkCloudJobResultNotices(owner.reference);
    const notice = formatCloudJobResultNotices(result);
    if (!notice) return;
    pendingCloudResults = result;
    try {
      await activeSession.rpc.send({
        prompt: `${notice}\nReport these results concisely. Do not call tools or save this notification to memory.`,
        displayPrompt: CLOUD_RESULT_DISPLAY_PROMPT,
        mode: "enqueue",
        billable: false,
        wait: true,
      });
      await completeCloudResultNotice(result);
    } catch (error) {
      if (pendingCloudResults === result) {
        pendingCloudResults = undefined;
        await releaseCloudJobResultNotices(result).catch(() => {});
      }
      skipNextAssistantCapture = false;
      throw error;
    }
  } catch (error) {
    if (!(error instanceof CloudJobsError &&
        error.code === "CLOUD_JOBS_NOT_CONFIGURED")) {
      process.stderr.write("Pinocchio: CLOUD_RESULT_NOTICE_UNAVAILABLE\n");
    }
  } finally {
    checkingCloudResults = false;
  }
}
const cloudResultStartupTimers = [1_000, 5_000].map((delay) => {
  const timer = setTimeout(() => {
    void queueCloudResultNotices();
  }, delay);
  timer.unref();
  return timer;
});
const cloudResultTimer = setInterval(() => {
  void queueCloudResultNotices();
}, 5 * 60 * 1000);
cloudResultTimer.unref();
for (const name of ["subagent.selected", "subagent.deselected"] as const) {
  session.on(name, () => { generation++; previousUser = ""; previousOwner = ""; context.resetRecall(); });
}
for (const role of ["user", "assistant"] as const) {
  session.on(role === "user" ? "user.message" : "assistant.message", (event) => {
    if (event.agentId || !event.data.content.trim()) return;
    if (event.type === "user.message" && (event.data.source || event.data.isAutopilotContinuation)) return;
    if (role === "assistant" && skipNextAssistantCapture) {
      skipNextAssistantCapture = false;
      if (pendingCloudResults) {
        void completeCloudResultNotice(pendingCloudResults).catch(() => {
          process.stderr.write("Pinocchio: CLOUD_RESULT_NOTICE_UNAVAILABLE\n");
        });
      }
      return;
    }
    if (event.type === "user.message") {
      const automaticNotice = event.data.delivery === "idle" &&
        event.data.content === CLOUD_RESULT_DISPLAY_PROMPT;
      skipNextAssistantCapture = automaticNotice;
      if (automaticNotice) return;
    }
    if (queued >= 32) {
      captureFailure = true; process.stderr.write("Pinocchio: CONVERSATION_QUEUE_FULL\n"); return;
    }
    const currentGeneration = generation;
    const workingDirectory = directory;
    if (!session || !workingDirectory) {
      captureFailure = true; process.stderr.write("Pinocchio: CONVERSATION_CONTEXT_UNAVAILABLE\n"); return;
    }
    const activeSession = session;
    queued++;
    pending = pending.then(async () => {
      const owner = await conversationOwner(configRoot, await activeSession.rpc.agent.getCurrent());
      if (!owner || currentGeneration !== generation) return;
      const previous = previousOwner === owner.reference.bindingId ? previousUser : "";
      const result = await captureConversation(owner.reference, {
        sessionId: activeSession.sessionId, id: event.id, timestamp: event.timestamp, role,
        content: event.data.content, directory: workingDirectory, ...(previous ? { context: previous } : {}),
      });
      if (result.status === "paused") { previousUser = ""; previousOwner = ""; }
      else if (role === "user" && result.status === "committed") {
        previousUser = event.data.content; previousOwner = owner.reference.bindingId;
      }
    }).catch((error: unknown) => {
      captureFailure = true;
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "CONVERSATION_CAPTURE_FAILED";
      process.stderr.write(`Pinocchio: ${code}\n`);
    }).finally(() => { queued--; });
  });
}
session.on("session.compaction_complete", () => {
  if (!session) return;
  void context.invalidate(session.sessionId).catch(() => {
    // Stop issuing tickets if visibility accounting cannot be persisted.
    context.close();
    process.stderr.write("Pinocchio: CONTEXT_ACCOUNTING_UNAVAILABLE\n");
  });
});
process.once("SIGTERM", () => {
  broadcastStopped = true;
  clearInterval(broadcastTimer);
  stopCloudMonitor();
  for (const timer of cloudResultStartupTimers) clearTimeout(timer);
  clearInterval(cloudResultTimer);
  const deadline = setTimeout(() => {
    process.stderr.write("Pinocchio: CONTEXT_DETACH_DEADLINE\n");
    process.exit(1);
  }, 4_000);
  void pending.then(async () => {
    await localJobs?.close();
    await broadcast.close();
    context.close();
    await session?.disconnect();
    jobsStore.close();
  }).then(() => {
    clearTimeout(deadline); process.exit(0);
  }, () => {
    clearTimeout(deadline);
    process.stderr.write("Pinocchio: CONTEXT_DETACH_FAILED\n");
    process.exit(1);
  });
});
