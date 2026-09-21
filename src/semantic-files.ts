import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { fingerprint, hasCode, loadBinding, privateDirectory } from "./binding-registry.js";
import type { BindingReference } from "./binding-registry.js";
import { privateStoreFile, storePath } from "./storage-files.js";
import { configSchema, DIMENSIONS, MAX_INDEX_RECORDS, manifestSchema, SemanticError } from "./semantic-types.js";

export function sha(data: Buffer | string) { return createHash("sha256").update(data).digest("hex"); }
export async function readPrivateJson(path: string, maxBytes = 1024 * 1024): Promise<unknown> {
  const info = await lstat(path);
  if (info.size > maxBytes) throw new SemanticError("SEMANTIC_FILE_OVERSIZED");
  await privateStoreFile(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(await file.readFile("utf8")) as unknown; }
  catch { throw new SemanticError("SEMANTIC_INVALID_JSON"); }
  finally { await file.close(); }
}
export async function writeAtomic(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let moved = false;
  try {
    await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); await file.close();
    await rename(temporary, path); moved = true;
    await syncDirectory(dirname(path));
  } finally {
    await file.close();
    if (!moved) await unlink(temporary);
  }
}
export async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await file.sync(); } finally { await file.close(); }
}
export async function semanticConfig(root: string) {
  await privateDirectory(join(root, "pinocchio"), false);
  const value = configSchema.safeParse(await readPrivateJson(join(root, "pinocchio", "semantic.json"), 4096));
  if (!value.success || !isAbsolute(value.data.python) || !isAbsolute(value.data.modelDirectory)) {
    throw new SemanticError("SEMANTIC_CONFIG_INVALID");
  }
  return value.data;
}
const retrievalSchema = z.object({ mode: z.enum(["hybrid", "keyword"]) }).strict();
export type RetrievalMode = z.infer<typeof retrievalSchema>["mode"];
export async function retrievalMode(reference: BindingReference): Promise<RetrievalMode> {
  await loadBinding(reference);
  try {
    await privateDirectory(join(reference.configRoot, "pinocchio", "retrieval"), false);
    return retrievalSchema.parse(await readPrivateJson(
      join(reference.configRoot, "pinocchio", "retrieval", `${reference.bindingId}.json`), 4096)).mode;
  } catch (error) { if (hasCode(error, "ENOENT")) return "hybrid"; throw error; }
}
export async function setRetrievalMode(reference: BindingReference, mode: RetrievalMode) {
  await loadBinding(reference);
  const directory = join(reference.configRoot, "pinocchio", "retrieval");
  await privateDirectory(directory, true);
  await writeAtomic(join(directory, `${reference.bindingId}.json`), retrievalSchema.parse({ mode }));
}
export async function indexDirectory(reference: BindingReference, create = false) {
  const binding = await loadBinding(reference);
  const database = await storePath(reference.configRoot, binding.namespace, false);
  const root = join(dirname(database), "semantic");
  await privateDirectory(root, create);
  const scope = `${binding.scope.kind}:${binding.scope.key}`;
  const directory = join(root, fingerprint(scope));
  await privateDirectory(directory, create);
  return { binding, scope, directory };
}
export async function activeIndex(reference: BindingReference) {
  const location = await indexDirectory(reference);
  const pointer = await readPrivateJson(join(location.directory, "active.json"), 4096);
  const schema = z.object({ generation: z.string().uuid(), manifestHash: z.string().length(64) }).strict();
  const active = schema.safeParse(pointer);
  if (!active.success) throw new SemanticError("INDEX_POINTER_INVALID");
  const directory = join(location.directory, active.data.generation);
  await privateDirectory(directory, false);
  const path = join(directory, "manifest.json");
  await privateStoreFile(path);
  const contents = await readPrivateJson(path);
  if (sha(await readFile(path)) !== active.data.manifestHash) throw new SemanticError("INDEX_MANIFEST_HASH_MISMATCH");
  const result = manifestSchema.safeParse(contents);
  if (!result.success || result.data.generation !== active.data.generation ||
      result.data.namespace !== location.binding.namespace || result.data.scope !== location.scope) {
    throw new SemanticError("INDEX_MODEL_OR_SCOPE_MISMATCH");
  }
  if (result.data.sourceHash !== sha(JSON.stringify(result.data.records)) ||
      new Set(result.data.records.map((record) => record.id)).size !== result.data.records.length) {
    throw new SemanticError("INDEX_RECORDS_INVALID");
  }
  await privateStoreFile(join(directory, "index.faiss"));
  if ((await lstat(join(directory, "index.faiss"))).size > MAX_INDEX_RECORDS * DIMENSIONS * 4 + 8192) {
    throw new SemanticError("INDEX_CAPACITY_EXCEEDED");
  }
  return { ...location, manifest: result.data, path: join(directory, "index.faiss") };
}
export function semanticFailure(error: unknown) {
  if (error instanceof SemanticError) return error.code;
  if (hasCode(error, "ENOENT")) return "SEMANTIC_NOT_CONFIGURED_OR_INDEX_MISSING";
  return "SEMANTIC_UNAVAILABLE";
}
