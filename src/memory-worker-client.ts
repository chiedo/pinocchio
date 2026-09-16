import { Worker } from "node:worker_threads";
import { ToolError } from "./memory-protocol.js";
import { isRecord } from "./identity.js";

interface Pending {
  id: number; payload: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>; stop?: () => void;
}
export class MemoryWorker {
  #worker: Worker | undefined;
  #queue: Pending[] = [];
  #active: Pending | undefined;
  #sequence = 0;
  #closed = false;
  constructor(private readonly createWorker: () => Worker = () => new Worker(new URL("./memory-worker.js", import.meta.url))) {}
  async initialize(configRoot: string) {
    const result = await this.call({ action: "health", configRoot }, Date.now() + 5_000);
    if (!isRecord(result) || result.status !== "ready") throw new ToolError("WORKER_STARTUP_FAILED");
  }
  call(payload: unknown, deadline = Date.now() + 1_000, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new ToolError("WORKER_CLOSED"));
    if (signal?.aborted) return Promise.reject(new ToolError("CALL_CANCELLED"));
    if (this.#queue.length >= 8) return Promise.reject(new ToolError("QUEUE_FULL"));
    if (deadline <= Date.now()) return Promise.reject(new ToolError("MEMORY_DEADLINE"));
    return new Promise((resolve, reject) => {
      const id = ++this.#sequence;
      const cancel = (code: string) => {
        const queued = this.#queue.findIndex((entry) => entry.id === id);
        if (queued !== -1) {
          const [entry] = this.#queue.splice(queued, 1);
          if (entry) { this.#cleanup(entry); entry.reject(new ToolError(code)); }
        } else if (this.#active?.id === id) this.#reset(code);
      };
      const entry: Pending = {
        id, payload, resolve, reject,
        expiresAt: performance.now() + Math.max(0, deadline - Date.now()),
        timer: setTimeout(() => cancel("MEMORY_DEADLINE"), Math.max(1, deadline - Date.now())),
      };
      if (signal) {
        const abort = () => cancel("CALL_CANCELLED");
        signal.addEventListener("abort", abort, { once: true });
        entry.stop = () => signal.removeEventListener("abort", abort);
      }
      this.#queue.push(entry);
      this.#next();
    });
  }
  #cleanup(entry: Pending) { clearTimeout(entry.timer); entry.stop?.(); }
  #reset(code: string) {
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker) { worker.removeAllListeners(); void worker.terminate(); }
    const active = this.#active;
    this.#active = undefined;
    if (active) { this.#cleanup(active); active.reject(new ToolError(code)); }
    this.#next();
  }
  #next() {
    if (this.#closed || this.#active) return;
    const next = this.#queue.shift();
    if (!next) return;
    if (performance.now() >= next.expiresAt) {
      this.#cleanup(next); next.reject(new ToolError("MEMORY_DEADLINE")); this.#next(); return;
    }
    this.#active = next;
    try {
    if (!this.#worker) {
      this.#worker = this.createWorker();
      this.#worker.on("message", (message: unknown) => {
        const current = this.#active;
        if (!current || !isRecord(message) || message.id !== current.id) return;
        this.#active = undefined;
        this.#cleanup(current);
        if (performance.now() >= current.expiresAt) current.reject(new ToolError("MEMORY_DEADLINE"));
        else if (typeof message.code === "string") {
          const revision = isRecord(message.details) ? message.details.currentRevision : undefined;
          current.reject(new ToolError(message.code, typeof revision === "number" ? { currentRevision: revision } : {}));
        }
        else current.resolve(message.value);
        this.#next();
      });
      this.#worker.on("error", () => this.#reset("WORKER_FAILED"));
      this.#worker.on("exit", () => this.#reset("WORKER_EXITED"));
    }
    this.#worker.postMessage({ id: next.id, payload: next.payload });
    } catch {
      this.#reset("WORKER_FAILED");
    }
  }
  close() {
    this.#closed = true;
    for (const entry of this.#queue.splice(0)) { this.#cleanup(entry); entry.reject(new ToolError("WORKER_CLOSED")); }
    this.#reset("WORKER_CLOSED");
  }
  async shutdown() {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#queue.splice(0)) {
      this.#cleanup(entry);
      entry.reject(new ToolError("WORKER_CLOSED"));
    }
    const active = this.#active;
    this.#active = undefined;
    if (active) {
      this.#cleanup(active);
      active.reject(new ToolError("WORKER_CLOSED"));
    }
    const worker = this.#worker;
    this.#worker = undefined;
    if (!worker) return;
    worker.removeAllListeners();
    const id = ++this.#sequence;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      worker.once("message", (message: unknown) => {
        if (isRecord(message) && message.id === id) done();
      });
      worker.once("error", done);
      worker.once("exit", done);
      try {
        worker.postMessage({ id, payload: { action: "shutdown" } });
      } catch {
        done();
      }
    });
    await worker.terminate().catch(() => {});
  }
}
