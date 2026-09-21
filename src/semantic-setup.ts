import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { hasCode, loadBinding, privateDirectory } from "./binding-registry.js";
import type { BindingReference } from "./binding-registry.js";
import { activeIndex, retrievalMode, semanticConfig, setRetrievalMode, writeAtomic } from "./semantic-files.js";
import type { RetrievalMode } from "./semantic-files.js";
import { rebuildIndex, indexStatus } from "./semantic-index.js";
import { ENGINE_PATH, SemanticProcess } from "./semantic-process.js";
import { candidateSchema, DIMENSIONS, MODEL_ID, MODEL_REVISION, SemanticError } from "./semantic-types.js";
import type { SemanticConfig } from "./semantic-types.js";

const execute = promisify(execFile);
export interface RetrievalSetupOptions { mode?: RetrievalMode | undefined; python?: string | undefined }

async function runtimeReady(config: SemanticConfig) {
  const engine = new SemanticProcess(config);
  try {
    await engine.ready();
    z.object({ status: z.literal("ready"), dimensions: z.literal(DIMENSIONS) })
      .parse(await engine.call({ action: "probe" }, 10_000));
  } finally { engine.close(); }
}

async function prepareRuntime(root: string, explicitPython?: string) {
  if (!explicitPython) {
    try {
      const existing = await semanticConfig(root);
      await runtimeReady(existing);
      return existing;
    } catch (error) {
      // An invalid existing configuration is not permission to replace it.
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  let python: string;
  if (explicitPython) {
    if (!isAbsolute(explicitPython)) throw new SemanticError("EXPLICIT_PYTHON_PATH_REQUIRED");
    python = join(await realpath(dirname(explicitPython)), basename(explicitPython));
    try { await execute(python, [ENGINE_PATH, "check-runtime"], { timeout: 30_000, maxBuffer: 4096 }); }
    catch { throw new SemanticError("SEMANTIC_EXPLICIT_PYTHON_DEPENDENCIES_REQUIRED"); }
  } else {
    let interpreter: string | undefined;
    for (const candidate of ["python3.12", "python3"]) {
      try {
        const result = await execute(candidate, ["-c", "import sys; print('%s.%s' % sys.version_info[:2])"],
          { timeout: 10_000, maxBuffer: 4096 });
        if (result.stdout.trim() === "3.12") { interpreter = candidate; break; }
      } catch (error) { if (!hasCode(error, "ENOENT")) throw new SemanticError("SEMANTIC_PYTHON_CHECK_FAILED"); }
    }
    if (!interpreter) throw new SemanticError("SEMANTIC_PYTHON_3_12_REQUIRED");
    const environment = join(root, "pinocchio", "semantic-runtime");
    await privateDirectory(environment, true);
    const venv = join(environment, "venv");
    await privateDirectory(venv, true);
    python = join(venv, "bin", "python");
    try { await execute(interpreter, ["-m", "venv", venv], { timeout: 60_000, maxBuffer: 4096 }); }
    catch { throw new SemanticError("SEMANTIC_VENV_CREATE_FAILED"); }
    try { await execute(python, [ENGINE_PATH, "check-runtime"], { timeout: 30_000, maxBuffer: 4096 }); }
    catch {
      try {
        await execute(python, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input",
          "--only-binary=:all:", "-r", join(dirname(ENGINE_PATH), "requirements.txt")],
        { timeout: 180_000, maxBuffer: 1024 * 1024 });
        await execute(python, [ENGINE_PATH, "check-runtime"], { timeout: 30_000, maxBuffer: 4096 });
      } catch { throw new SemanticError("SEMANTIC_DEPENDENCY_INSTALL_FAILED"); }
    }
  }
  await privateDirectory(join(root, "pinocchio", "embeddings"), true);
  const modelDirectory = join(root, "pinocchio", "embeddings", MODEL_REVISION);
  try { await execute(python, [ENGINE_PATH, "prepare", modelDirectory], { timeout: 180_000, maxBuffer: 4096 }); }
  catch { throw new SemanticError("SEMANTIC_MODEL_PREPARE_FAILED"); }
  const config: SemanticConfig = { version: 1, python, modelDirectory, model: MODEL_ID };
  await runtimeReady(config);
  await writeAtomic(join(root, "pinocchio", "semantic.json"), config);
  return config;
}

export async function setupRetrieval(reference: BindingReference, options: RetrievalSetupOptions = {}) {
  await loadBinding(reference);
  if (options.mode === "keyword" && options.python) throw new SemanticError("KEYWORD_ONLY_PYTHON_CONFLICT");
  const directory = join(reference.configRoot, "pinocchio");
  await privateDirectory(directory, true);
  const path = join(directory, "semantic-setup.lock");
  let lock;
  try { lock = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (hasCode(error, "EEXIST")) throw new SemanticError("SEMANTIC_SETUP_BUSY"); throw error; }
  try {
    const mode = options.mode ?? await retrievalMode(reference);
    if (mode === "keyword") {
      if (options.python) throw new SemanticError("KEYWORD_ONLY_PYTHON_CONFLICT");
      await setRetrievalMode(reference, mode);
      return { mode, status: "ready", reason: "KEYWORD_ONLY_CONFIGURED" } as const;
    }
    const config = await prepareRuntime(reference.configRoot, options.python);
    await rebuildIndex(reference);
    const active = await activeIndex(reference);
    const engine = new SemanticProcess(config);
    try {
      await engine.ready();
      z.object({ candidates: z.array(candidateSchema).max(50) }).parse(await engine.call({
        action: "search", path: active.path, sha256: active.manifest.indexHash,
        records: active.manifest.records, query: "Semantic retrieval readiness",
      }, 1_000));
    } finally { engine.close(); }
    const state = await indexStatus(reference);
    if (state.status !== "ready" || state.disabled || state.pendingPhysicalCleanup || state.staleVectors ||
        state.indexJobs.some((job) => job.status === "pending" && Number(job.count) > 0)) {
      throw new SemanticError("SEMANTIC_INDEX_NOT_CURRENT");
    }
    await setRetrievalMode(reference, mode);
    return { mode, status: "ready", vectors: state.vectors, model: MODEL_ID } as const;
  } finally { await lock.close(); await unlink(path); }
}
