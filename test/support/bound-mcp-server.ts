import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { isRecord } from "../../src/identity.js";

// Synthetic stdio fixture only, not a production memory server or installer.
const [definition, repository, journal] = process.argv.slice(2);
if (
  !definition || !/^(foreground|alpha|beta)$/.test(definition) ||
  !repository || !/^repository-(one|two)$/.test(repository) ||
  !journal
) {
  throw new Error("INVALID_SYNTHETIC_SERVER_BINDING");
}
const binding = Object.freeze({ definition, repository });

function respond(id: unknown, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

for await (const line of createInterface({ input: process.stdin })) {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" },
    })}\n`);
    continue;
  }
  if (!isRecord(request) || !Object.hasOwn(request, "id")) continue;
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "synthetic-bound-identity", version: "1.0.0" },
    });
  } else if (request.method === "ping") {
    respond(request.id, {});
  } else if (request.method === "tools/list") {
    respond(request.id, { tools: [{
      name: "identity",
      description: "Return the synthetic launch binding. No memory access.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }] });
  } else if (request.method === "tools/call") {
    const params = request.params;
    const valid = isRecord(params) && params.name === "identity" &&
      (params.arguments === undefined ||
        (isRecord(params.arguments) && Object.keys(params.arguments).length === 0));
    if (!valid) {
      respond(request.id, {
        isError: true, content: [{ type: "text", text: "INVALID_ARGUMENTS" }],
      });
      continue;
    }
    appendFileSync(journal, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
    respond(request.id, {
      content: [{ type: "text", text: JSON.stringify(binding) }],
    });
  } else {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0", id: request.id,
      error: { code: -32601, message: "Method not found" },
    })}\n`);
  }
}
