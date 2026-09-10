import { joinSession } from "@github/copilot-sdk/extension";
import { configRootPath } from "./binding-registry.js";
import { createMemoryHooks } from "./memory-hooks.js";
import { isRecord } from "./identity.js";

const context = createMemoryHooks(configRootPath());
const session = await joinSession({
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
        return { resultType: "success", textResultForLlm: JSON.stringify(await context.health()) };
      } catch {
        return { resultType: "failure", textResultForLlm: '{"status":"unavailable","code":"CONTEXT_UNAVAILABLE"}' };
      }
    },
  }],
});
session.on("session.compaction_complete", () => {
  void context.invalidate(session.sessionId).catch(() => {
    // Stop issuing tickets if visibility accounting cannot be persisted.
    context.close();
    process.stderr.write("Pinocchio: CONTEXT_ACCOUNTING_UNAVAILABLE\n");
  });
});
process.once("SIGTERM", () => { context.close(); process.exit(0); });
