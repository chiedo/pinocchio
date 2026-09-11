import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BindingError, configRootPath, loadBinding, privateDirectory } from "./binding-registry.js";
import { MemoryStore } from "./memory-store.js";
import { MemoryError } from "./memory-types.js";
import { SemanticRuntime } from "./semantic-runtime.js";
import { rebuildIndex, cleanupIndex, indexStatus } from "./semantic-index.js";
import { SemanticProcess, ENGINE_PATH } from "./semantic-process.js";
import { semanticConfig, semanticFailure, writeAtomic } from "./semantic-files.js";
import { MODEL_ID, MODEL_REVISION, SemanticError } from "./semantic-types.js";
import type { SemanticConfig } from "./semantic-types.js";

const execute = promisify(execFile);
export async function main(args: string[]) {
  const { positionals, values } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    "config-root": { type: "string" }, python: { type: "string" },
    binding: { type: "string" }, fingerprint: { type: "string" }, query: { type: "string" },
  } });
  if (positionals.length !== 1) throw new SemanticError("INVALID_ARGUMENTS");
  const command = positionals[0];
  const allowed = command === "prepare" ? ["config-root", "python"]
    : command === "search" ? ["config-root", "binding", "fingerprint", "query"]
    : ["config-root", "binding", "fingerprint"];
  if (Object.keys(values).some((key) => !allowed.includes(key))) throw new SemanticError("INVALID_ARGUMENTS");
  const root = configRootPath(values["config-root"]);
  if (command === "prepare") {
    if (!values.python || !isAbsolute(values.python)) throw new SemanticError("EXPLICIT_PYTHON_PATH_REQUIRED");
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (await realpath(root) !== root) throw new SemanticError("INVALID_CONFIG_ROOT");
    await privateDirectory(join(root, "pinocchio"), true);
    await privateDirectory(join(root, "pinocchio", "embeddings"), true);
    const modelDirectory = join(root, "pinocchio", "embeddings", MODEL_REVISION);
    const python = join(await realpath(dirname(values.python)), basename(values.python));
    await execute(python, [ENGINE_PATH, "prepare", modelDirectory], { timeout: 180_000, maxBuffer: 4096 });
    const config: SemanticConfig = { version: 1, python, modelDirectory, model: MODEL_ID };
    const engine = new SemanticProcess(config);
    try { await engine.ready(); } finally { engine.close(); }
    await writeAtomic(join(root, "pinocchio", "semantic.json"), config);
    return { status: "prepared", model: MODEL_ID, dimensions: 384, downloadBytes: 23_684_031 };
  }
  if (!values.binding || !values.fingerprint) throw new SemanticError("EXPLICIT_BINDING_REQUIRED");
  const reference = { configRoot: root, bindingId: values.binding, fingerprint: values.fingerprint };
  if (command === "rebuild") return rebuildIndex(reference);
  if (command === "status") return indexStatus(reference);
  if (command === "cleanup") {
    const engine = new SemanticProcess(await semanticConfig(root));
    try { await engine.ready(); return await cleanupIndex(reference, engine); }
    finally { engine.close(); }
  }
  if (command === "search") {
    if (!values.query) throw new SemanticError("QUERY_REQUIRED");
    const binding = await loadBinding(reference);
    const store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: binding.scope.kind });
    const runtime = new SemanticRuntime(false);
    try {
      let warmFailure: string | undefined;
      try { await runtime.warm(reference); } catch (error) { warmFailure = semanticFailure(error); }
      const result = warmFailure ? { retrieval: { mode: "keyword" as const, reason: warmFailure }, candidates: undefined }
        : await runtime.candidates(reference, values.query);
      return await store.searchSnapshot(values.query, { limit: 20 }, (matches) => ({
        ...matches, retrieval: result.retrieval,
      }), result.candidates ?? []);
    } finally { await runtime.close(); store.close(); }
  }
  throw new SemanticError("INVALID_ARGUMENTS");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`); }
  catch (error) {
    const code = error instanceof SemanticError || error instanceof BindingError || error instanceof MemoryError
      ? error.code : "SEMANTIC_COMMAND_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "error", code })}\n`);
    process.exitCode = 1;
  }
}
