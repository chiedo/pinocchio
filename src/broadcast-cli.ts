import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { configRootPath, listBindingReferences, loadBinding } from "./binding-registry.js";
import { refreshEnrollment } from "./enrollment.js";
import {
  broadcastCode, broadcastRuntimeVersion, broadcastSnapshot, broadcastStatus,
  publishBroadcast, withBroadcastLock,
} from "./broadcast.js";
import type { BroadcastRequest } from "./broadcast.js";

export async function upgradeBroadcast(root: string) {
  return withBroadcastLock(root, async () => {
    const request: BroadcastRequest = {
      version: 1, id: randomUUID(), createdAt: Date.now(),
      runtime: await broadcastRuntimeVersion(), targets: [], agents: [],
    };
    for (const reference of await listBindingReferences(root)) {
      let agent = reference.bindingId;
      try {
        const binding = await loadBinding(reference);
        agent = basename(binding.definition.path, ".agent.md");
        const text = await readFile(binding.definition.path, "utf8");
        if (!text.includes("<!-- pinocchio-memory:v1 -->")) continue;
        await refreshEnrollment(reference);
        request.targets.push((await broadcastSnapshot(reference)).target);
        request.agents.push({ bindingId: reference.bindingId, agent, status: "refreshed" });
      } catch (error) {
        request.agents.push({ bindingId: reference.bindingId, agent, status: "failed", code: broadcastCode(error) });
      }
    }
    if (!request.agents.length) throw Object.assign(new Error("NO_ENROLLED_AGENTS"), { code: "NO_ENROLLED_AGENTS" });
    await publishBroadcast(root, request);
    return broadcastStatus(root);
  });
}
export async function main(args: string[]) {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true, options: { "config-root": { type: "string" } },
  });
  if (positionals.length !== 1 || !["upgrade", "status"].includes(positionals[0] ?? "")) {
    throw Object.assign(new Error("Usage: npm run broadcast -- upgrade|status [--config-root PATH]"), { code: "INVALID_ARGUMENTS" });
  }
  const root = configRootPath(values["config-root"]);
  return positionals[0] === "upgrade" ? upgradeBroadcast(root) : broadcastStatus(root);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.agents.some((agent) => agent.status === "failed") ||
        result.sessions.some((session) => ["failed", "restart-required"].includes(session.status))) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "error", code: broadcastCode(error) })}\n`);
    process.exitCode = 1;
  }
}
