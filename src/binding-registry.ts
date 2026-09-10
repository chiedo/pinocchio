import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const pathSchema = z.string().min(1).refine(isAbsolute);
const directoryStampSchema = z.object({
  device: z.string(), inode: z.string(),
}).strict();
const recordSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  definition: z.object({
    id: digestSchema,
    origin: z.enum(["project", "user", "plugin"]),
    root: pathSchema,
    path: pathSchema,
  }).strict(),
  namespace: z.string().regex(/^[a-z0-9-]+--[a-f0-9]{64}$/),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("global"), key: z.literal("global") }).strict(),
    z.object({
      kind: z.literal("repository"), key: digestSchema, root: pathSchema,
      directory: directoryStampSchema, git: directoryStampSchema,
    }).strict(),
  ]),
}).strict();
export type BindingRecord = z.infer<typeof recordSchema>;
export type DefinitionOrigin = BindingRecord["definition"]["origin"];
export interface BindingReference {
  configRoot: string;
  bindingId: string;
  fingerprint: string;
}
export interface RegisterBindingOptions {
  configRoot?: string;
  definitionPath: string;
  origin: DefinitionOrigin;
  originRoot: string;
  scope: { kind: "global" } | { kind: "repository"; root: string };
}
export type BindingCode =
  | "INVALID_BINDING" | "UNKNOWN_BINDING" | "REVOKED_BINDING" | "STALE_BINDING"
  | "INSECURE_REGISTRY" | "REGISTRY_IO_ERROR" | "INVALID_DEFINITION"
  | "INVALID_REPOSITORY" | "AMBIGUOUS_CONFIG_ROOT" | "UNSUPPORTED_PLATFORM"
  | "BINDING_DEADLINE" | "CALL_CANCELLED" | "ADAPTER_DISPOSED"
  | "INVALID_TOOL_ARGUMENTS" | "OPERATION_FAILED";

export class BindingError extends Error {
  constructor(readonly code: BindingCode) {
    super(code);
    this.name = "BindingError";
  }
}
export function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === code;
}
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function configRootPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicit !== undefined) {
    if (!explicit.trim()) throw new BindingError("INVALID_BINDING");
    return resolve(explicit);
  }
  const home = env.COPILOT_HOME;
  const config = env.COPILOT_CONFIG_DIR;
  if (home && config && resolve(home) !== resolve(config)) {
    throw new BindingError("AMBIGUOUS_CONFIG_ROOT");
  }
  return resolve(config || home || join(homedir(), ".copilot"));
}
function registryPath(configRoot: string) {
  return join(configRoot, "pinocchio", "bindings");
}
function supportedPlatform() {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new BindingError("UNSUPPORTED_PLATFORM");
  }
}
function validateReference(reference: BindingReference) {
  if (
    !isAbsolute(reference.configRoot) ||
    !z.string().uuid().safeParse(reference.bindingId).success ||
    !digestSchema.safeParse(reference.fingerprint).success
  ) throw new BindingError("INVALID_BINDING");
}
export async function privateDirectory(path: string, create: boolean) {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new BindingError("INSECURE_REGISTRY");
  }
}
async function checkRegistry(configRoot: string, create = false) {
  supportedPlatform();
  if (create) await mkdir(configRoot, { recursive: true, mode: 0o700 });
  if (await realpath(configRoot) !== configRoot) throw new BindingError("STALE_BINDING");
  await privateDirectory(join(configRoot, "pinocchio"), create);
  await privateDirectory(registryPath(configRoot), create);
}
async function stamp(path: string) {
  const info = await stat(path, { bigint: true });
  return { device: info.dev.toString(), inode: info.ino.toString() };
}
function sameStamp(left: z.infer<typeof directoryStampSchema>, right: z.infer<typeof directoryStampSchema>) {
  return left.device === right.device && left.inode === right.inode;
}
function within(root: string, path: string) {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
function definitionId(origin: DefinitionOrigin, root: string, path: string) {
  return fingerprint(JSON.stringify([1, origin, root, path]));
}
function namespace(path: string, id: string) {
  const slug = basename(path, ".agent.md").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
  return `${slug}--${id}`;
}
async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function writeExclusive(path: string, text: string) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text); await file.sync(); }
  finally { await file.close(); }
}
export async function registerBinding(options: RegisterBindingOptions): Promise<BindingReference> {
  supportedPlatform();
  const chosenRoot = configRootPath(options.configRoot);
  await mkdir(chosenRoot, { recursive: true, mode: 0o700 });
  const configRoot = await realpath(chosenRoot);
  await checkRegistry(configRoot, true);
  const root = await realpath(options.originRoot);
  const path = await realpath(options.definitionPath);
  if (
    !(await stat(root)).isDirectory() || !(await stat(path)).isFile() ||
    !path.endsWith(".agent.md") || !within(root, path)
  ) throw new BindingError("INVALID_DEFINITION");
  const id = definitionId(options.origin, root, path);
  let scope: BindingRecord["scope"];
  if (options.scope.kind === "global") {
    scope = { kind: "global", key: "global" };
  } else {
    let gitRoot: string;
    try {
      const result = await exec("git", ["-C", options.scope.root, "rev-parse", "--show-toplevel"], {
        timeout: 750, maxBuffer: 16_384,
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      gitRoot = await realpath(result.stdout.trim());
    } catch { throw new BindingError("INVALID_REPOSITORY"); }
    scope = {
      kind: "repository",
      root: gitRoot,
      key: fingerprint(JSON.stringify([1, gitRoot])),
      directory: await stamp(gitRoot),
      git: await stamp(join(gitRoot, ".git")),
    };
  }
  const record = recordSchema.parse({
    version: 1, id: randomUUID(),
    definition: { id, origin: options.origin, root, path },
    namespace: namespace(path, id), scope,
  });
  const text = JSON.stringify(record);
  await writeExclusive(join(registryPath(configRoot), `${record.id}.json`), text);
  await syncDirectory(registryPath(configRoot));
  return { configRoot, bindingId: record.id, fingerprint: fingerprint(text) };
}
async function assertNotRevoked(reference: BindingReference) {
  try {
    await lstat(join(registryPath(reference.configRoot), `${reference.bindingId}.revoked`));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  throw new BindingError("REVOKED_BINDING");
}
async function readRecord(reference: BindingReference, signal?: AbortSignal): Promise<BindingRecord> {
  validateReference(reference);
  signal?.throwIfAborted();
  await checkRegistry(reference.configRoot);
  const path = join(registryPath(reference.configRoot), `${reference.bindingId}.json`);
  let text: string;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16_384 || (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())) {
      throw new BindingError("INSECURE_REGISTRY");
    }
    text = await file.readFile({ encoding: "utf8", ...(signal ? { signal } : {}) });
  } finally { await file.close(); }
  if (fingerprint(text) !== reference.fingerprint) throw new BindingError("STALE_BINDING");
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new BindingError("INVALID_BINDING"); }
  const parsed = recordSchema.safeParse(json);
  if (!parsed.success) throw new BindingError("INVALID_BINDING");
  const record = parsed.data;
  const definition = record.definition;
  if (
    record.id !== reference.bindingId ||
    definition.id !== definitionId(definition.origin, definition.root, definition.path) ||
    record.namespace !== namespace(definition.path, definition.id) ||
    !within(definition.root, definition.path)
  ) throw new BindingError("INVALID_BINDING");
  return record;
}
export async function loadBinding(reference: BindingReference, signal?: AbortSignal): Promise<BindingRecord> {
  const record = await readRecord(reference, signal);
  await assertNotRevoked(reference);
  const definition = record.definition;
  if (
    await realpath(definition.root) !== definition.root ||
    await realpath(definition.path) !== definition.path ||
    !(await stat(definition.path)).isFile()
  ) throw new BindingError("STALE_BINDING");
  if (record.scope.kind === "repository") {
    const scope = record.scope;
    if (
      await realpath(scope.root) !== scope.root ||
      scope.key !== fingerprint(JSON.stringify([1, scope.root])) ||
      !sameStamp(scope.directory, await stamp(scope.root)) ||
      !sameStamp(scope.git, await stamp(join(scope.root, ".git")))
    ) throw new BindingError("STALE_BINDING");
  }
  signal?.throwIfAborted();
  await assertNotRevoked(reference);
  return record;
}
export async function revokeBinding(reference: BindingReference): Promise<void> {
  // Revocation must remain possible after the definition or repository is gone.
  await readRecord(reference);
  try {
    await writeExclusive(join(registryPath(reference.configRoot), `${reference.bindingId}.revoked`), "");
  } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  await syncDirectory(registryPath(reference.configRoot));
}
