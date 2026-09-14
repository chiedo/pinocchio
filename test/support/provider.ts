import { createServer } from "node:http";
import { isRecord } from "../../src/identity.js";
import { IDENTITY_TOOL_NAME } from "../../src/tool.js";

export interface SyntheticProviderOptions {
  textOnly?: boolean;
  replyWithoutTools?: boolean;
  selectTool?: (messages: Record<string, unknown>[]) => string;
  allowUnofferedTool?: boolean;
  toolArguments?: (messages: Record<string, unknown>[]) => Record<string, unknown>;
}

export async function startSyntheticProvider(options: SyntheticProviderOptions = {}) {
  let requests = 0;
  let toolRequests = 0;
  let failures = 0;
  const failureCodes = new Set<string>();
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2_000_000) {
          throw new Error("SYNTHETIC_REQUEST_TOO_LARGE");
        }
        chunks.push(Buffer.from(chunk));
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isRecord(input) || !Array.isArray(input.messages)) {
        throw new Error("SYNTHETIC_REQUEST_INVALID");
      }
      requests += 1;
      if (requests > 60) {
        throw new Error("SYNTHETIC_REQUEST_LIMIT");
      }
      const messages = input.messages.filter(isRecord);
      const toolName = options.selectTool?.(messages) ?? IDENTITY_TOOL_NAME;
      const lastUser = messages.findLastIndex((item) => item.role === "user");
      const replied = options.textOnly || (options.replyWithoutTools && (!Array.isArray(input.tools) || input.tools.length === 0)) || messages
        .slice(lastUser + 1)
        .some((item) => item.role === "tool");
      if (!replied) {
        const tools = Array.isArray(input.tools) ? input.tools : [];
        const offered = tools.some(
          (tool: unknown) =>
            isRecord(tool) &&
            isRecord(tool.function) &&
            tool.function.name === toolName,
        );
        if (!offered && !options.allowUnofferedTool) {
          throw new Error("IDENTITY_TOOL_NOT_OFFERED");
        }
        toolRequests += 1;
      }
      const toolCalls = [
        {
          id: `synthetic-tool-${requests}`,
          type: "function",
          function: { name: toolName, arguments: JSON.stringify(options.toolArguments?.(messages) ?? {}) },
        },
      ];
      const message = replied
        ? { role: "assistant", content: "Synthetic check complete." }
        : { role: "assistant", content: null, tool_calls: toolCalls };
      const finishReason = replied ? "stop" : "tool_calls";
      const base = {
        id: `synthetic-completion-${requests}`,
        created: 0,
        model: "synthetic-model",
      };
      if (input.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = replied
          ? { role: "assistant", content: "Synthetic check complete." }
          : {
              role: "assistant",
              tool_calls: toolCalls.map((call, index) => ({ index, ...call })),
            };
        for (const choice of [
          { index: 0, delta, finish_reason: null },
          { index: 0, delta: {}, finish_reason: finishReason },
        ]) {
          response.write(
            `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [choice] })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ...base,
            object: "chat.completion",
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
    } catch (error) {
      failures += 1;
      const code =
        error instanceof Error &&
        /^(SYNTHETIC_[A-Z_]+|IDENTITY_TOOL_NOT_OFFERED)$/.test(error.message)
          ? error.message
          : "SYNTHETIC_PROVIDER_ERROR";
      failureCodes.add(code);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: code, type: "synthetic" } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("SYNTHETIC_PROVIDER_ADDRESS_INVALID");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    counts: () => ({
      requests,
      toolRequests,
      failures,
      failureCodes: [...failureCodes].sort(),
    }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
