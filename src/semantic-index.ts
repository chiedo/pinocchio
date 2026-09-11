import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BindingReference } from "./binding-registry.js";
import { BindingError, hasCode, loadBinding, privateDirectory } from "./binding-registry.js";
import { MemoryStore } from "./memory-store.js";
import { MemoryError } from "./memory-types.js";
import { SemanticProcess } from "./semantic-process.js";
import { activeIndex, indexDirectory, semanticConfig, semanticFailure, sha, syncDirectory, writeAtomic } from "./semantic-files.js";
import { DIMENSIONS, MODEL_ID, SemanticError } from "./semantic-types.js";
import type { IndexManifest } from "./semantic-types.js";

export async function cleanupIndex(reference: BindingReference, process: SemanticProcess, alreadyLocked = false) {
  const location = await indexDirectory(reference, true);
  if (!alreadyLocked) await process.call({ action: "acquire", path: join(location.directory, "builder.lock") }, 1_000);
  const active = await activeIndex(reference);
  let removed = 0;
  for (const name of await readdir(location.directory)) {
    if (name === active.manifest.generation || !/^(?:\.staging-)?[a-f0-9-]{36}$/.test(name)) continue;
    const path = join(location.directory, name);
    await privateDirectory(path, false);
    await rm(path, { recursive: true }); removed++;
  }
  await syncDirectory(location.directory);
  return { removed, pendingPhysicalCleanup: false };
}
export async function rebuildIndex(reference: BindingReference) {
  const config = await semanticConfig(reference.configRoot);
  const binding = await loadBinding(reference);
  const store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: binding.scope.kind });
  const engine = new SemanticProcess(config);
  try {
    await engine.ready();
    const location = await indexDirectory(reference, true);
    await engine.call({ action: "acquire", path: join(location.directory, "builder.lock") }, 1_000);
    const snapshot = await store.indexSnapshot();
    const records = snapshot.map(({ id, revision }) => ({ id, revision }));
    const sourceHash = sha(JSON.stringify(records));
    let existing: Awaited<ReturnType<typeof activeIndex>> | undefined;
    let recoveredFrom: string | undefined;
    try { existing = await activeIndex(reference); }
    catch (error) {
      if (error instanceof BindingError || error instanceof MemoryError ||
          (!(error instanceof SemanticError) && !hasCode(error, "ENOENT"))) throw error;
      recoveredFrom = semanticFailure(error);
    }
    if (existing?.manifest.sourceHash === sourceHash &&
        sha(await readFile(existing.path)) === existing.manifest.indexHash) {
      await store.publishIndex(snapshot, async () => {});
      return { status: "current", generation: existing.manifest.generation,
        ...(await cleanupIndex(reference, engine, true)) };
    }
    const generation = randomUUID();
    const staging = join(location.directory, `.staging-${generation}`);
    await mkdir(staging, { mode: 0o700 });
    const built = z.object({ sha256: z.string().length(64), bytes: z.number().int().positive() }).parse(
      await engine.call({ action: "build", records: snapshot, path: join(staging, "index.faiss") }, 120_000),
    );
    const manifest: IndexManifest = {
      version: 1, generation, namespace: binding.namespace, scope: location.scope,
      model: MODEL_ID, dimensions: DIMENSIONS, sourceHash, indexHash: built.sha256, records,
      createdAt: new Date().toISOString(),
    };
    await writeAtomic(join(staging, "manifest.json"), manifest);
    await syncDirectory(staging);
    const published = join(location.directory, generation);
    await rename(staging, published);
    await syncDirectory(location.directory);
    const manifestHash = sha(await readFile(join(published, "manifest.json")));
    await store.publishIndex(snapshot, () => writeAtomic(join(location.directory, "active.json"), { generation, manifestHash }));
    try {
      return { status: "indexed", generation, records: records.length,
        ...(recoveredFrom ? { recoveredFrom } : {}), ...(await cleanupIndex(reference, engine, true)) };
    } catch (error) {
      return { status: "indexed", generation, records: records.length, pendingPhysicalCleanup: true,
        cleanupError: semanticFailure(error) };
    }
  } finally { engine.close(); store.close(); }
}
export async function indexStatus(reference: BindingReference) {
  const binding = await loadBinding(reference);
  const store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: binding.scope.kind });
  try {
    const state = await store.status();
    try {
      const active = await activeIndex(reference);
      const live = new Map((await store.indexMetadata()).map((record) => [record.id, record.revision]));
      const staleVectors = active.manifest.records.filter((record) => live.get(record.id) !== record.revision).length;
      const leftovers = (await readdir(active.directory)).filter((name) =>
        name !== active.manifest.generation && /^(?:\.staging-)?[a-f0-9-]{36}$/.test(name));
      return { status: "ready", generation: active.manifest.generation, vectors: active.manifest.records.length,
        staleVectors, obsoleteGenerations: leftovers.length, pendingPhysicalCleanup: staleVectors > 0 || leftovers.length > 0,
        indexJobs: state.indexJobs, disabled: state.disabled,
        cleanupScope: "disk generations; process caches refresh on next query or exit and are not inspected" };
    } catch (error) {
      if (error instanceof SemanticError && error.code === "INDEX_CAPACITY_EXCEEDED") throw error;
      return { status: "degraded", reason: semanticFailure(error), indexJobs: state.indexJobs, disabled: state.disabled,
        cleanupState: "unknown until a valid generation is rebuilt" };
    }
  } finally { store.close(); }
}
