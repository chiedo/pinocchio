import type { SessionHooks } from "@github/copilot-sdk";
import { MemoryWorker } from "./memory-worker-client.js";
import { CONTEXT_META, MEMORY_DEADLINE_MS, SAVE_TOOL, SEARCH_TOOL, ToolError } from "./memory-protocol.js";

export function createMemoryHooks(configRoot: string) {
  const worker = new MemoryWorker();
  const hooks: SessionHooks = {
    async onUserPromptSubmitted(input, invocation) {
      try {
        await worker.call({
          action: "start", configRoot, root: invocation.sessionId, recipient: input.sessionId,
          stamp: new Date(input.timestamp).toISOString(),
        });
      } catch {
        worker.close();
        return { additionalContext: "Pinocchio memory context is unavailable. Continue without memory; do not claim a save." };
      }
    },
    async onPreMcpToolCall(input, invocation) {
      if (!input.serverName.startsWith("pinocchio_") || ![SEARCH_TOOL, SAVE_TOOL].includes(input.toolName)) return;
      const deadline = Date.now() + MEMORY_DEADLINE_MS;
      try {
        const ticket = await worker.call({
          action: "ticket", configRoot, root: invocation.sessionId, recipient: input.sessionId,
          call: input.toolCallId ?? "", server: input.serverName, tool: input.toolName,
          arguments: input.arguments, deadline,
        }, deadline);
        return { metaToUse: { [CONTEXT_META]: ticket } };
      } catch (error) {
        return { metaToUse: { pinocchioUnavailable: error instanceof ToolError ? error.code : "CONTEXT_UNAVAILABLE" } };
      }
    },
  };
  return {
    hooks,
    health: () => worker.call({ action: "health", configRoot }),
    invalidate: (root: string) => worker.call({ action: "invalidate", configRoot, root }),
    close: () => worker.close(),
  };
}
