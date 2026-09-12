import type { SessionHooks } from "@github/copilot-sdk";
import { MemoryWorker } from "./memory-worker-client.js";
import { CONTEXT_META, MEMORY_DEADLINE_MS, SAVE_TOOL, SEARCH_TOOL, ToolError } from "./memory-protocol.js";
import { recallConversation } from "./conversation-memory.js";
import type { ConversationOwner } from "./conversation-memory.js";

export function createMemoryHooks(configRoot: string, onPrompt?: (input: {
  prompt: string; sessionId: string; workingDirectory: string;
}) => Promise<string | undefined>) {
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
      if (input.sessionId === invocation.sessionId && onPrompt) {
        try {
          const additionalContext = await onPrompt(input);
          if (additionalContext) return { additionalContext };
        } catch {
          process.stderr.write("Pinocchio: CONVERSATION_RECALL_UNAVAILABLE\n");
          return { additionalContext: "Pinocchio automatic conversation recall is unavailable. Tell the user; do not claim to remember an earlier conversation." };
        }
      }
    },
    async onPreMcpToolCall(input, invocation) {
      if (!input.serverName.startsWith("pinocchio_") || ![SEARCH_TOOL, SAVE_TOOL].includes(input.toolName)) return;
      const deadline = Date.now() + MEMORY_DEADLINE_MS;
      try {
        const ticket = await worker.call({
          action: "ticket", configRoot, root: invocation.sessionId, recipient: input.sessionId,
          call: input.toolCallId ?? "", server: input.serverName, tool: input.toolName,
          directory: input.workingDirectory,
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
    recall: (owner: ConversationOwner, input: { sessionId: string; directory: string; prompt: string }) =>
      recallConversation(worker, owner, input),
    invalidate: (root: string) => worker.call({ action: "invalidate", configRoot, root }),
    close: () => worker.close(),
  };
}
