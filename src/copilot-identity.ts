import { denyIdentity, isRecord } from "./identity.js";
import type { IdentityAdapter, IdentityResolution } from "./identity.js";

export class CopilotIdentityAdapter implements IdentityAdapter {
  #disposed = false;

  resolveCall(invocation: unknown): IdentityResolution {
    if (this.#disposed) {
      return denyIdentity("STALE_ADAPTER");
    }
    if (
      !isRecord(invocation) ||
      !["sessionId", "toolCallId", "toolName"].every(
        (key) =>
          Object.hasOwn(invocation, key) &&
          typeof invocation[key] === "string" &&
          invocation[key].trim().length > 0,
      )
    ) {
      return denyIdentity("INVALID_HOST_CONTEXT");
    }
    if (invocation.signal !== undefined) {
      if (!(invocation.signal instanceof AbortSignal)) {
        return denyIdentity("INVALID_HOST_CONTEXT");
      }
      if (invocation.signal.aborted) {
        return denyIdentity("CALL_CANCELLED");
      }
    }

    // Session IDs, tracing IDs and the selected foreground agent are not a
    // per-call definition/origin binding. Unknown extra fields grant no authority.
    return denyIdentity("HOST_IDENTITY_UNSUPPORTED");
  }

  dispose(): void {
    this.#disposed = true;
  }
}
