import { joinSession } from "@github/copilot-sdk/extension";
import { configRootPath } from "./binding-registry.js";
import { createMemoryHooks } from "./memory-hooks.js";

const context = createMemoryHooks(configRootPath());
const session = await joinSession({ hooks: context.hooks });
session.on("session.compaction_complete", () => {
  void context.invalidate(session.sessionId).catch(() => {
    // Stop issuing tickets if visibility accounting cannot be persisted.
    context.close();
    process.stderr.write("Pinocchio: CONTEXT_ACCOUNTING_UNAVAILABLE\n");
  });
});
process.once("SIGTERM", () => { context.close(); process.exit(0); });
