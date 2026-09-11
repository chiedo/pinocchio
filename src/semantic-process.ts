import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isRecord } from "./identity.js";
import { SemanticError } from "./semantic-types.js";
import type { SemanticConfig } from "./semantic-types.js";

export const ENGINE_PATH = fileURLToPath(new URL("../../semantic/engine.py", import.meta.url));
export class SemanticProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  #buffer = "";
  #ready = false;
  #failure: string | undefined;
  #nextId = 0;
  #pending: { id: number; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  #readyWaiters = new Set<() => void>();
  constructor(config: SemanticConfig) {
    this.#child = spawn(config.python, ["-u", ENGINE_PATH, "serve", config.modelDirectory], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
        HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1",
        OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", TOKENIZERS_PARALLELISM: "false" },
    });
    this.#child.stderr.on("data", () => { /* Only structured, content-free protocol errors are surfaced. */ });
    this.#child.on("error", () => this.#fail("SEMANTIC_RUNTIME_MISSING"));
    this.#child.on("exit", () => this.#fail("SEMANTIC_PROCESS_EXITED"));
    this.#child.stdin.on("error", () => this.#fail("SEMANTIC_PIPE_FAILED"));
    this.#child.stdout.on("data", (data: Buffer) => {
      this.#buffer += data.toString("utf8");
      if (this.#buffer.length > 4 * 1024 * 1024) { this.#fail("SEMANTIC_RESPONSE_OVERSIZED"); return; }
      let end: number;
      while ((end = this.#buffer.indexOf("\n")) !== -1) {
        const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
        let message: unknown;
        try { message = JSON.parse(line); } catch { this.#fail("SEMANTIC_PROTOCOL_ERROR"); return; }
        if (!isRecord(message)) { this.#fail("SEMANTIC_PROTOCOL_ERROR"); return; }
        if (message.ready === true) {
          this.#ready = true;
          for (const notify of this.#readyWaiters) notify();
        } else if (this.#pending && message.id === this.#pending.id) {
          const pending = this.#pending; this.#pending = undefined; clearTimeout(pending.timer);
          if (typeof message.code === "string") pending.reject(new SemanticError(message.code));
          else pending.resolve(message.value);
        } else if (typeof message.code === "string") this.#fail(message.code);
      }
    });
  }
  get state() { return this.#failure ?? (this.#ready ? "ready" : "SEMANTIC_WARMING"); }
  #fail(code: string) {
    this.#failure ??= code;
    if (this.#pending) {
      const pending = this.#pending; this.#pending = undefined; clearTimeout(pending.timer);
      pending.reject(new SemanticError(this.#failure));
    }
    for (const notify of this.#readyWaiters) notify();
    this.#child.kill();
  }
  async ready(timeout = 30_000) {
    if (this.state === "ready") return;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.#failure || this.#ready) {
          clearTimeout(timer); this.#readyWaiters.delete(check);
          if (this.#failure) reject(new SemanticError(this.#failure)); else resolve();
        }
      };
      const timer = setTimeout(() => { this.#readyWaiters.delete(check); this.#fail("SEMANTIC_STARTUP_TIMEOUT"); reject(new SemanticError("SEMANTIC_STARTUP_TIMEOUT")); }, timeout);
      this.#readyWaiters.add(check); check();
    });
  }
  call(payload: unknown, timeout = 250): Promise<unknown> {
    if (this.state !== "ready") return Promise.reject(new SemanticError(this.state));
    if (this.#pending) return Promise.reject(new SemanticError("SEMANTIC_BUSY"));
    const id = ++this.#nextId;
    const frame = JSON.stringify({ id, payload }) + "\n";
    if (Buffer.byteLength(frame) > 8 * 1024 * 1024) return Promise.reject(new SemanticError("INDEX_CAPACITY_EXCEEDED"));
    return new Promise((resolve, reject) => {
      this.#pending = { id, resolve, reject, timer: setTimeout(() => this.#fail("SEMANTIC_TIMEOUT"), timeout) };
      this.#child.stdin.write(frame);
    });
  }
  close() { this.#fail("SEMANTIC_CLOSED"); }
}
