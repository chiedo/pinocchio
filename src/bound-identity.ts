import {
  BindingError, hasCode, loadBinding,
} from "./binding-registry.js";
import type { BindingCode, BindingRecord, BindingReference } from "./binding-registry.js";

export const BINDING_BUDGET_MS = 900;
export interface BoundIdentity {
  readonly definitionId: string;
  readonly namespace: string;
  readonly scope: Readonly<{ kind: "repository" | "global"; key: string }>;
}
export type BoundResult<T> =
  | { status: "bound"; identity: BoundIdentity; value: T }
  | { status: "unavailable"; code: BindingCode };

function identity(record: BindingRecord): BoundIdentity {
  return Object.freeze({
    definitionId: record.definition.id,
    namespace: record.namespace,
    scope: Object.freeze({ kind: record.scope.kind, key: record.scope.key }),
  });
}
export class BoundIdentityAdapter {
  readonly #reference: Readonly<BindingReference>;
  #disposed = false;
  constructor(reference: BindingReference) {
    this.#reference = Object.freeze({ ...reference });
  }
  dispose() { this.#disposed = true; }

  async withIdentity<T>(
    operation: (binding: BoundIdentity, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<BoundResult<T>> {
    if (this.#disposed) return { status: "unavailable", code: "ADAPTER_DISPOSED" };
    if (signal?.aborted) return { status: "unavailable", code: "CALL_CANCELLED" };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort(new BindingError("CALL_CANCELLED"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const stopped = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        timer = setTimeout(
          () => controller.abort(new BindingError("BINDING_DEADLINE")),
          BINDING_BUDGET_MS,
        );
      });
      const work = async (): Promise<BoundResult<T>> => {
        const record = await loadBinding(this.#reference, controller.signal);
        if (this.#disposed) throw new BindingError("ADAPTER_DISPOSED");
        controller.signal.throwIfAborted();
        const bound = identity(record);
        const value = await operation(bound, controller.signal);
        controller.signal.throwIfAborted();
        await loadBinding(this.#reference, controller.signal);
        if (this.#disposed) throw new BindingError("ADAPTER_DISPOSED");
        controller.signal.throwIfAborted();
        return { status: "bound", identity: bound, value };
      };
      return await Promise.race([work(), stopped]);
    } catch (error) {
      const code = error instanceof BindingError ? error.code
        : hasCode(error, "ENOENT") ? "UNKNOWN_BINDING"
        : hasCode(error, "ELOOP") ? "INSECURE_REGISTRY"
        : hasCode(error, "EACCES") || hasCode(error, "EPERM") ? "REGISTRY_IO_ERROR"
        : "OPERATION_FAILED";
      return { status: "unavailable", code };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  async resolve(signal?: AbortSignal) {
    const result = await this.withIdentity(async () => undefined, signal);
    return result.status === "bound"
      ? { status: "bound" as const, identity: result.identity }
      : result;
  }
}
