import assert from "node:assert/strict";
import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";

export async function deferExtension(
  client: CopilotClient,
  name = "pinocchio-memory",
) {
  const discovered = await client.rpc.extensions.discover();
  const extension = discovered.extensions.find((item) => item.name === name);
  assert.ok(extension, `EXTENSION_NOT_FOUND:${name}`);
  await client.rpc.extensions.disable({ ids: [extension.id] });
  return extension.id;
}

export async function enableExtension(
  session: CopilotSession,
  id: string,
) {
  await session.rpc.extensions.enable({ id });
}

export async function disableExtension(
  session: CopilotSession,
  id: string,
) {
  await session.rpc.extensions.disable({ id });
}
