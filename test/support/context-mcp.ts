import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "synthetic-context", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "context_probe", description: "Synthetic trusted hook context check.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => ({
  content: [{ type: "text", text: JSON.stringify(extra._meta ?? {}) }],
}));
await server.connect(new StdioServerTransport());
