import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { BindingError, configRootPath } from "./binding-registry.js";
import { MemoryStore } from "./memory-store.js";
import { acknowledge, MemoryError, noteSchema, validate } from "./memory-types.js";
import type { MemoryReceipt } from "./memory-types.js";
import { SemanticRuntime } from "./semantic-runtime.js";
import { semanticFailure } from "./semantic-files.js";
import { cliInvocation, writeCliError, writeCliResult } from "./cli-output.js";

const INPUT_LIMIT = 128 * 1024;
async function input(path: string | undefined) {
  if (!path) throw new MemoryError("INVALID_INPUT");
  const chunks: Buffer[] = [];
  let length = 0;
  const file = path === "-" ? undefined : await open(path, "r");
  try {
    if (file && !(await file.stat()).isFile()) throw new MemoryError("INVALID_INPUT");
    const stream = file ? file.createReadStream({ autoClose: false }) : process.stdin;
    for await (const chunk of stream) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > INPUT_LIMIT) throw new MemoryError("INVALID_INPUT");
      chunks.push(buffer);
    }
  } finally { await file?.close(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new MemoryError("INVALID_INPUT"); }
  return validate(noteSchema, value);
}
function integer(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new MemoryError("INVALID_INPUT");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new MemoryError("INVALID_INPUT");
  return parsed;
}
export async function main(args: string[]) {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: {
      "config-root": { type: "string" }, binding: { type: "string" }, fingerprint: { type: "string" },
      namespace: { type: "string" }, scope: { type: "string" }, operation: { type: "string" },
      input: { type: "string" }, record: { type: "string" }, "expected-revision": { type: "string" },
      query: { type: "string" }, limit: { type: "string" }, offset: { type: "string" },
      hybrid: { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "";
  const options: Record<string, string[]> = {
    remember: ["input", "operation"],
    correct: ["input", "record", "expected-revision", "operation"],
    forget: ["record", "expected-revision", "operation"],
    list: ["limit", "offset"], search: ["query", "limit", "offset", "hybrid"],
    inspect: ["record", "limit", "offset"], status: [], operation: ["operation"],
    disable: ["operation"], enable: ["operation"],
  };
  const allowed = options[command];
  if (positionals.length !== 1 || !allowed ||
      Object.keys(values).some((key) => ![
        "config-root", "binding", "fingerprint", "namespace", "scope", ...allowed,
      ].includes(key)) || !values.binding || !values.fingerprint || !values.namespace ||
      (values.scope !== "repository" && values.scope !== "global")) {
    throw new MemoryError("INVALID_INPUT");
  }
  const limit = integer(values.limit);
  const offset = integer(values.offset);
  const pagination = { ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) };
  const expected = integer(values["expected-revision"]);
  const note = command === "remember" || command === "correct" ? await input(values.input) : undefined;
  const reference = {
    configRoot: configRootPath(values["config-root"]), bindingId: values.binding,
    fingerprint: values.fingerprint,
  };
  const store = await MemoryStore.open(reference, { namespace: values.namespace, scope: values.scope });
  let committedOperation: string | undefined;
  try {
    const result = await (async () => { switch (command) {
      case "remember":
        if (!note) throw new MemoryError("INVALID_INPUT");
        return await store.remember(note, values.operation ?? "");
      case "correct":
        if (!note) throw new MemoryError("INVALID_INPUT");
        return await store.correct(values.record ?? "", expected ?? 0, note, values.operation ?? "");
      case "forget": return await store.forget(values.record ?? "", expected ?? 0, values.operation ?? "");
      case "list": return await store.list(pagination);
      case "search": {
        if (!values.hybrid) return await store.search(values.query ?? "", pagination);
        if ((await store.status()).disabled) throw new MemoryError("STORE_DISABLED");
        const runtime = new SemanticRuntime(false);
        try {
          let failure: string | undefined;
          try { await runtime.warm(reference); } catch (error) { failure = semanticFailure(error); }
          const result = failure ? { retrieval: { mode: "keyword" as const, reason: failure }, candidates: undefined }
            : await runtime.candidates(reference, values.query ?? "");
          return await store.searchSnapshot(values.query ?? "", pagination, (matches) => ({
            ...matches, retrieval: result.retrieval,
          }), result.candidates ?? []);
        } finally { await runtime.close(); }
      }
      case "inspect": return await store.inspect(values.record ?? "", pagination);
      case "status": return await store.status();
      case "operation": return await store.operationStatus(values.operation ?? "");
      case "disable": return await store.setDisabled(true, values.operation ?? "");
      case "enable": return await store.setDisabled(false, values.operation ?? "");
      default: throw new MemoryError("INVALID_INPUT");
    } })();
    if (result.status === "committed") committedOperation = result.operationId;
    return result;
  } finally {
    try { store.close(); }
    catch (error) {
      if (committedOperation) throw new MemoryError("OUTCOME_UNKNOWN", { operationId: committedOperation });
      throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const invocation = cliInvocation(process.argv.slice(2));
  // A failed pipe must report an unknown acknowledgement, not an unhandled EPIPE.
  process.stdout.on("error", () => { process.exitCode = 1; });
  try {
    const result = await main(invocation.args);
    const writeResult = (value: unknown) => writeCliResult(value, invocation.json);
    if (result.status === "committed") await acknowledge(result satisfies MemoryReceipt, writeResult);
    else await writeResult(result);
  } catch (error) {
    const code = error instanceof MemoryError || error instanceof BindingError
      ? error.code : error instanceof TypeError ? "INVALID_INPUT" : "STORE_IO_ERROR";
    const details = error instanceof MemoryError ? error.details : {};
    writeCliError({ code, details }, invocation.json);
    process.exitCode = 1;
  }
}
