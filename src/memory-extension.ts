import { joinSession } from "@github/copilot-sdk/extension";
import { configRootPath } from "./binding-registry.js";
import { createMemoryHooks } from "./memory-hooks.js";
import { isRecord } from "./identity.js";
import { captureConversation, conversationOwner } from "./conversation-memory.js";
import { extensionSaveInputSchema, EXTENSION_SAVE_TOOL, EXTENSION_SEARCH_TOOL, SAVE_TOOL, SEARCH_TOOL, searchSchema, ToolError } from "./memory-protocol.js";
import { z } from "zod";

const configRoot = configRootPath();
let session: Awaited<ReturnType<typeof joinSession>> | undefined;
let pending = Promise.resolve();
let queued = 0;
let generation = 0;
let directory = process.cwd();
let captureFailure = false;
let previousUser = "";
let previousOwner = "";
const context = createMemoryHooks(configRoot, async (input) => {
  directory = input.workingDirectory;
  await pending;
  if (!session) return;
  const owner = await conversationOwner(configRoot, await session.rpc.agent.getCurrent());
  if (!owner) return;
  const recalled = await context.recall(owner, {
    sessionId: input.sessionId, directory: input.workingDirectory, prompt: input.prompt,
  });
  return `${captureFailure ? "Pinocchio automatic capture failed for an earlier message. Tell the user; do not claim it was saved.\n" : ""}${recalled}`;
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
      description: "Search the selected Pinocchio agent's scoped historical memory. Recall is best-effort.",
      parameters: z.toJSONSchema(searchSchema, { io: "input" }),
    },
    {
      name: EXTENSION_SAVE_TOOL,
      description: "Save, correct, or check a sourced memory operation for the selected Pinocchio agent.",
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
        const owner = await conversationOwner(configRoot, await session.rpc.agent.getCurrent());
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
      }
    },
  }))],
});
for (const name of ["subagent.selected", "subagent.deselected"] as const) {
  session.on(name, () => { generation++; previousUser = ""; previousOwner = ""; });
}
for (const role of ["user", "assistant"] as const) {
  session.on(role === "user" ? "user.message" : "assistant.message", (event) => {
    if (event.agentId || !event.data.content.trim()) return;
    if (event.type === "user.message" && (event.data.source || event.data.isAutopilotContinuation)) return;
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
  const deadline = setTimeout(() => {
    process.stderr.write("Pinocchio: CONTEXT_DETACH_DEADLINE\n");
    process.exit(1);
  }, 4_000);
  void pending.then(async () => { context.close(); await session?.disconnect(); }).then(() => {
    clearTimeout(deadline); process.exit(0);
  }, () => {
    clearTimeout(deadline);
    process.stderr.write("Pinocchio: CONTEXT_DETACH_FAILED\n");
    process.exit(1);
  });
});
