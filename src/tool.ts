import type { Tool, ToolInvocation, ToolResultObject } from "@github/copilot-sdk";
import { CopilotIdentityAdapter } from "./copilot-identity.js";
import { denyIdentity, isRecord } from "./identity.js";
import type { IdentityAdapter } from "./identity.js";

export const IDENTITY_TOOL_NAME = "pinocchio_identity_status";

export type IdentityTool = Omit<Tool<unknown>, "handler"> & {
  handler(args: unknown, invocation: ToolInvocation): ToolResultObject;
};

export function createIdentityTool(
  adapter: IdentityAdapter = new CopilotIdentityAdapter(),
): IdentityTool {
  return {
    name: IDENTITY_TOOL_NAME,
    description:
      "Check Pinocchio's caller-identity compatibility. Diagnostic only: no memory reads, writes or namespace selection. Unsupported is final, not a request to retry.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    defer: "never",
    handler(args, invocation): ToolResultObject {
      const resolution =
        isRecord(args) && Reflect.ownKeys(args).length === 0
          ? adapter.resolveCall(invocation)
          : denyIdentity("INVALID_TOOL_ARGUMENTS");
      return {
        resultType: "failure",
        textResultForLlm: JSON.stringify(resolution),
        error: resolution.code,
        sessionLog: `Pinocchio: ${resolution.code}. ${resolution.message}`,
      };
    },
  };
}
