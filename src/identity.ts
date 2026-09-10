export const IDENTITY_DEADLINE_MS = 1_000;

export type IdentityCode =
  | "HOST_IDENTITY_UNSUPPORTED"
  | "INVALID_HOST_CONTEXT"
  | "CALL_CANCELLED"
  | "STALE_ADAPTER"
  | "INVALID_TOOL_ARGUMENTS";

export interface IdentityResolution {
  readonly status: "unsupported" | "unavailable";
  readonly code: IdentityCode;
  readonly message: string;
  readonly scopes: {
    readonly repository: "unavailable";
    readonly global: "unavailable";
  };
}

export interface IdentityAdapter {
  resolveCall(invocation: unknown): IdentityResolution;
  dispose(): void;
}

const messages: Record<IdentityCode, string> = {
  HOST_IDENTITY_UNSUPPORTED:
    "The public host contract does not bind this call to a stable agent definition and scope. No namespace was selected. Do not retry with an agent name.",
  INVALID_HOST_CONTEXT:
    "Trusted host call metadata is missing or invalid. No namespace was selected.",
  CALL_CANCELLED:
    "The host cancelled this call. No namespace was selected.",
  STALE_ADAPTER:
    "This identity adapter is no longer active. No namespace was selected.",
  INVALID_TOOL_ARGUMENTS:
    "This diagnostic accepts no arguments, owners or target scopes. No namespace was selected.",
};

const unavailableScopes = Object.freeze({
  repository: "unavailable" as const,
  global: "unavailable" as const,
});

export function denyIdentity(code: IdentityCode): IdentityResolution {
  return Object.freeze({
    status: code === "HOST_IDENTITY_UNSUPPORTED" ? "unsupported" : "unavailable",
    code,
    message: messages[code],
    scopes: unavailableScopes,
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
