import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BoundIdentityAdapter } from "./bound-identity.js";
import { isRecord } from "./identity.js";
import type { BindingReference } from "./binding-registry.js";

export const BOUND_IDENTITY_TOOL = "identity_status";

export function createBoundMcpServer(reference: BindingReference) {
  const adapter = new BoundIdentityAdapter(reference);
  const server = new Server(
    { name: "pinocchio-bound-identity", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: BOUND_IDENTITY_TOOL,
      description: "Resolve this server's trusted agent/scope binding. Diagnostic only; no memory access.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments;
    const valid = request.params.name === BOUND_IDENTITY_TOOL &&
      (args === undefined || (isRecord(args) && Reflect.ownKeys(args).length === 0));
    const result = valid
      ? await adapter.resolve(extra.signal)
      : { status: "unavailable", code: "INVALID_TOOL_ARGUMENTS" };
    return {
      isError: result.status !== "bound",
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  });
  server.onclose = () => adapter.dispose();
  return server;
}
