import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { configRootPath, hasCode, loadBinding, privateDirectory } from "./binding-registry.js";
import type { BindingReference } from "./binding-registry.js";
import { main as enrollmentCommand } from "./enrollment-cli.js";
import { contextExtensionContent, removeEnrollment } from "./enrollment.js";
import { MemoryStore } from "./memory-store.js";
import { ToolError } from "./memory-protocol.js";
import { readPrivateJson, writeAtomic } from "./semantic-files.js";
import { PUBLIC_NODE, packageRelease, releaseRoot, releaseSchema, verifyRelease } from "./release.js";

const execute = promisify(execFile);
const stateSchema = z.object({
  format: z.literal(1), release: releaseSchema, previous: releaseSchema.optional(),
  enabled: z.boolean(), installed: z.boolean(),
  enrollments: z.array(z.object({
    configRoot: z.string(), bindingId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    disabledBefore: z.boolean().optional(),
  }).strict()),
}).strict();
type State = z.infer<typeof stateSchema>;

export async function locations(explicit?: string) {
  const root = configRootPath(explicit);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw new ToolError("CONFIG_ROOT_SYMLINK");
  const runtime = join(root, "pinocchio-runtime");
  await privateDirectory(runtime, true);
  return { root, runtime, app: join(runtime, "app"), previous: join(runtime, "previous"),
    state: join(runtime, "install.json"), launcher: join(runtime, "pinocchio") };
}
type Locations = Awaited<ReturnType<typeof locations>>;
async function stateAt(paths: Locations) {
  const state = stateSchema.parse(await readPrivateJson(paths.state));
  if (state.enrollments.some((ref) => ref.configRoot !== paths.root)) throw new ToolError("INSTALL_STATE_SCOPE_MISMATCH");
  return state;
}
export async function withInstallLock<T>(paths: Locations, action: () => Promise<T>) {
  const lock = join(paths.runtime, "installer.lock");
  let handle;
  try { handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (hasCode(error, "EEXIST")) throw new ToolError("INSTALLER_BUSY"); throw error; }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }) + "\n"); await handle.sync();
    return await action();
  } finally { await handle.close(); await unlink(lock); }
}
async function exists(path: string) {
  try { await lstat(path); return true; }
  catch (error) { if (hasCode(error, "ENOENT")) return false; throw error; }
}
async function ownedApp(path: string, release: State["release"]) {
  await privateDirectory(path, false);
  const actual = releaseSchema.parse(JSON.parse(await readFile(join(path, "release.json"), "utf8")));
  if (JSON.stringify(actual) !== JSON.stringify(release)) throw new ToolError("INSTALLED_RELEASE_CHANGED");
}
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
async function launcher(paths: Locations) {
  const text = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(paths.app, "dist/src/install-cli.js"))} --config-root ${quote(paths.root)} "$@"\n`;
  if (await exists(paths.launcher)) {
    const info = await lstat(paths.launcher);
    if (!info.isFile() || info.isSymbolicLink() || await readFile(paths.launcher, "utf8") !== text) {
      throw new ToolError("LAUNCHER_CONFLICT");
    }
  } else await writeFile(paths.launcher, text, { mode: 0o700, flag: "wx" });
}
export async function install(paths: Locations, upgrade: boolean, stopped: boolean, previewPlatform: boolean) {
  if (process.versions.node !== PUBLIC_NODE) throw new ToolError("NODE_22_18_0_REQUIRED");
  if (!(process.platform === "linux" && process.arch === "x64") &&
      !(previewPlatform && process.platform === "darwin")) throw new ToolError("PLATFORM_UNVALIDATED");
  if (!relative(releaseRoot, paths.root).startsWith("..")) throw new ToolError("PRIVATE_ROOT_MUST_BE_OUTSIDE_SOURCE");
  let state: State | undefined;
  if (await exists(paths.state)) state = await stateAt(paths);
  if (state?.installed && !upgrade) throw new ToolError("ALREADY_INSTALLED");
  if (upgrade && (!state?.installed || !stopped)) throw new ToolError("UPGRADE_REQUIRES_INSTALL_AND_STOPPED_HOSTS");
  if (state?.installed) {
    await ownedApp(paths.app, state.release);
    if (state.previous || await exists(paths.previous)) throw new ToolError("REMOVE_PREVIOUS_BEFORE_NEXT_UPGRADE");
  } else if (await exists(paths.app)) throw new ToolError("INSTALL_DIRECTORY_CONFLICT");
  const stage = join(paths.runtime, `stage-${randomUUID()}`);
  let promoted = false;
  try {
    if (await exists(join(releaseRoot, "release.json"))) {
      const release = await verifyRelease(releaseRoot);
      await mkdir(stage, { mode: 0o700 });
      for (const path of [...Object.keys(release.files), "release.json"]) {
        await mkdir(dirname(join(stage, path)), { recursive: true, mode: 0o700 });
        await cp(join(releaseRoot, path), join(stage, path), { errorOnExist: true, force: false });
      }
    } else {
      const commit = await execute("git", ["rev-parse", "HEAD"], { cwd: releaseRoot, timeout: 5_000 });
      await packageRelease(stage, commit.stdout.trim());
    }
    const release = await verifyRelease(stage);
    if (state?.installed && state.release.storageSchema !== release.storageSchema) throw new ToolError("SCHEMA_UPGRADE_UNSUPPORTED");
    await execute("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: stage, timeout: 180_000, maxBuffer: 1024 * 1024,
    });
    // The candidate runs against isolated synthetic state, never enrolled user profiles.
    try {
      await execute(process.execPath, [join(stage, "dist/src/install-cli.js"), "doctor",
        ...(previewPlatform ? ["--preview-platform"] : [])], { timeout: 300_000, maxBuffer: 16_384 });
    } catch (error) {
      if (typeof error === "object" && error && "stderr" in error && typeof error.stderr === "string") {
        const code = /"code":"([A-Z0-9_]+)"/.exec(error.stderr)?.[1];
        if (code) throw new ToolError(code);
      }
      throw new ToolError("INSTALL_DIAGNOSTIC_PROCESS_FAILED");
    }
    await launcher(paths);
    if (state?.installed) await rename(paths.app, paths.previous);
    try { await rename(stage, paths.app); promoted = true; }
    catch (error) {
      if (state?.installed) await rename(paths.previous, paths.app);
      throw error;
    }
    await writeAtomic(paths.state, {
      format: 1, release, ...(state?.installed ? { previous: state.release } : {}),
      enabled: state?.installed ? state.enabled : true, installed: true,
      enrollments: state?.installed ? state.enrollments : [],
    } satisfies State);
    return { status: "installed", version: release.version, launcher: paths.launcher,
      configRoot: paths.root, liveCertification: "unvalidated", desktop: "unvalidated",
      platform: previewPlatform ? "unvalidated-preview" : "linux-x64", restartRequired: true };
  } finally {
    if (!promoted && await exists(stage)) await rm(stage, { recursive: true });
  }
}
export async function status(paths: Locations) {
  const state = await stateAt(paths);
  return { status: state.installed ? "installed" : "uninstalled", version: state.release.version,
    commit: state.release.commit, enabled: state.enabled, agents: state.enrollments.length,
    rollbackAvailable: Boolean(state.previous), liveCertification: state.release.liveCertification,
    runtime: paths.app, privateState: [join(paths.root, "pinocchio"), join(paths.root, "agent-memories")] };
}
export async function createAgent(paths: Locations, args: string[]) {
  const state = await stateAt(paths);
  if (!state.installed || !state.enabled) throw new ToolError("INSTALLATION_DISABLED");
  const result = await enrollmentCommand(["create", "--config-root", paths.root, ...args],
    async (reference) => {
      state.enrollments.push(reference);
      await writeAtomic(paths.state, state);
    });
  return result;
}
async function storeFor(reference: BindingReference) {
  const binding = await loadBinding(reference);
  return MemoryStore.open(reference, { namespace: binding.namespace, scope: binding.scope.kind });
}
export async function setEnabled(paths: Locations, enabled: boolean) {
  const state = await stateAt(paths);
  if (!state.installed) throw new ToolError("NOT_INSTALLED");
  for (const ref of state.enrollments) {
    const store = await storeFor(ref);
    try {
      if (!enabled && ref.disabledBefore === undefined) {
        ref.disabledBefore = (await store.status()).disabled;
        await writeAtomic(paths.state, state);
      }
      if (!enabled || ref.disabledBefore !== undefined) {
        await store.setDisabled(enabled ? ref.disabledBefore ?? true : true, randomUUID());
      }
      if (enabled) delete ref.disabledBefore;
      await writeAtomic(paths.state, state);
    } finally { store.close(); }
  }
  state.enabled = enabled;
  await writeAtomic(paths.state, state);
  return { status: enabled ? "enabled" : "disabled", recordsPreserved: true };
}
export async function uninstall(paths: Locations, stopped: boolean) {
  if (!stopped) throw new ToolError("STOP_HOSTS_FIRST");
  const state = await stateAt(paths);
  if (!state.installed) throw new ToolError("NOT_INSTALLED");
  await ownedApp(paths.app, state.release);
  await launcher(paths);
  if (state.previous) await ownedApp(paths.previous, state.previous);
  const extension = join(paths.root, "extensions", "pinocchio-memory", "extension.mjs");
  if (await exists(extension) && await readFile(extension, "utf8") !== contextExtensionContent()) {
    throw new ToolError("CONTEXT_EXTENSION_CONFLICT");
  }
  const enrolled: BindingReference[] = [];
  for (const ref of state.enrollments) {
    const binding = await loadBinding(ref);
    if (!(await readFile(binding.definition.path, "utf8")).includes("<!-- pinocchio-memory:")) continue;
    await removeEnrollment(ref, true);
    enrolled.push(ref);
  }
  for (const ref of enrolled) await removeEnrollment(ref);
  if (await exists(extension)) await unlink(extension);
  await rm(paths.app, { recursive: true });
  if (state.previous) await rm(paths.previous, { recursive: true });
  await unlink(paths.launcher);
  state.installed = false; state.enabled = false; delete state.previous;
  await writeAtomic(paths.state, state);
  return { status: "uninstalled", recordsPreserved: true, profilesPreserved: true,
    privateStatePreserved: true, restartRequired: true };
}
export async function rollback(paths: Locations, stopped: boolean) {
  if (!stopped) throw new ToolError("STOP_HOSTS_FIRST");
  const state = await stateAt(paths);
  if (!state.installed || !state.previous) throw new ToolError("NO_ROLLBACK");
  await ownedApp(paths.app, state.release); await ownedApp(paths.previous, state.previous);
  const temporary = join(paths.runtime, `rollback-${randomUUID()}`);
  await rename(paths.app, temporary);
  try { await rename(paths.previous, paths.app); }
  catch (error) { await rename(temporary, paths.app); throw error; }
  await rename(temporary, paths.previous);
  [state.release, state.previous] = [state.previous, state.release];
  await writeAtomic(paths.state, state);
  return { status: "rolled_back", version: state.release.version, recordsPreserved: true, restartRequired: true };
}
export async function discardPrevious(paths: Locations, stopped: boolean) {
  if (!stopped) throw new ToolError("STOP_HOSTS_FIRST");
  const state = await stateAt(paths);
  if (!state.previous) throw new ToolError("NO_ROLLBACK");
  await ownedApp(paths.previous, state.previous);
  await rm(paths.previous, { recursive: true });
  delete state.previous;
  await writeAtomic(paths.state, state);
  return { status: "previous_runtime_removed", recordsPreserved: true };
}
export async function start(paths: Locations, agent?: string) {
  const state = await stateAt(paths);
  if (!state.installed) throw new ToolError("NOT_INSTALLED");
  const child = spawn(join(paths.app, "node_modules/.bin/copilot"),
    ["--experimental", "--no-auto-update", "--extension-sdk-path",
      join(paths.app, "node_modules/@github/copilot-sdk/dist"), ...(agent ? ["--agent", agent] : [])], {
      stdio: "inherit", env: { ...process.env, COPILOT_HOME: paths.root, COPILOT_CONFIG_DIR: paths.root },
    });
  return new Promise<void>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => { process.exitCode = code ?? 1; done(); });
  });
}
