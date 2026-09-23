import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { privateDirectory } from "./binding-registry.js";

const exec = promisify(execFile);
const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const refSchema = z.string().regex(/^[A-Za-z0-9._/-]+$/).max(200)
  .refine((value) =>
    value !== "@" &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{"),
  );
const pathSchema = z.string().min(1).max(500).refine((value) =>
  !value.startsWith("/") &&
  !value.split("/").some((part) => !part || part === "." || part === "..") &&
  /^[A-Za-z0-9._/-]+$/.test(value),
);
const promptPathSchema = z.string().min(1).max(500)
  .transform((value) => value.startsWith("./") ? value.slice(2) : value)
  .pipe(pathSchema);
const jobIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,49}$/);
const requiredToolsSchema = z.array(z.string().min(1).max(200)).max(50).default([]);

export const repositoryJobSchema = z.object({
  version: z.literal(1),
  id: jobIdSchema,
  schedule: z.object({
    cron: z.string().trim().min(1).max(200),
    timezone: z.string().trim().min(1).max(100).default("UTC"),
  }).strict().optional(),
  execution: z.object({
    "working-directory": z.enum(["subscriber", "source"]).default("subscriber"),
    "required-tools": requiredToolsSchema,
    "timeout-minutes": z.number().int().min(1).max(360).default(30),
    "max-ai-credits": z.number().int().positive().max(100).optional(),
  }).strict().default({
    "working-directory": "subscriber",
    "required-tools": [],
    "timeout-minutes": 30,
  }),
  prompt: z.string().trim().min(1).max(32 * 1024).optional(),
  "prompt-file": promptPathSchema.optional(),
}).strict().refine(
  (value) => Number(value.prompt !== undefined) + Number(value["prompt-file"] !== undefined) === 1,
  "Exactly one of prompt or prompt-file is required",
);

export const githubJobSourceSchema = z.object({
  kind: z.literal("github"),
  locator: z.string().min(1).max(1_000),
  repository: repositorySchema,
  ref: refSchema,
  path: pathSchema,
  resolvedCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  definitionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  lastSyncedAt: z.string(),
  checkoutDirectory: z.string().min(1),
  workingDirectoryMode: z.enum(["subscriber", "source"]),
  automaticExecutionAllowed: z.boolean().default(true),
  allowedTools: requiredToolsSchema,
  maximumTimeoutMinutes: z.number().int().min(1).max(360),
  maximumAiCredits: z.number().int().positive().max(100).optional(),
  syncError: z.string().optional(),
}).strict();

export type GitHubJobSource = z.infer<typeof githubJobSourceSchema>;

export interface ResolvedRepositoryJob {
  id: string;
  prompt: string;
  cron?: string;
  timezone: string;
  requiredTools: string[];
  timeoutMinutes: number;
  maxAiCredits?: number;
  workingDirectoryMode: "subscriber" | "source";
  sourceDirectory: string;
  source: Omit<
    GitHubJobSource,
    "workingDirectoryMode" | "automaticExecutionAllowed" | "allowedTools" |
    "maximumTimeoutMinutes" | "maximumAiCredits" | "syncError"
  >;
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceHome() {
  return resolve(process.env.PINOCCHIO_HOME ?? join(homedir(), ".pinocchio"));
}

async function sourceRoot(agent: string) {
  const home = sourceHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  await privateDirectory(home, false);
  const agentRoot = join(home, agent);
  await privateDirectory(agentRoot, true, true);
  const jobs = join(agentRoot, "jobs");
  await privateDirectory(jobs, true);
  const sources = join(jobs, "sources");
  await privateDirectory(sources, true);
  return sources;
}

function gitEnvironment() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

async function git(args: string[], cwd?: string) {
  try {
    return await exec("git", cwd ? ["-C", cwd, ...args] : args, {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: gitEnvironment(),
    });
  } catch {
    throw Object.assign(new Error("JOB_SOURCE_SYNC_FAILED"), {
      code: "JOB_SOURCE_SYNC_FAILED",
    });
  }
}

async function withCheckoutLock<T>(path: string, operation: () => Promise<T>) {
  const lock = `${path}.lock`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      try {
        return await operation();
      } finally {
        await rmdir(lock).catch(() => {});
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) ||
          error.code !== "EEXIST") throw error;
      let age: number;
      try {
        age = Date.now() - (await stat(lock)).mtimeMs;
      } catch {
        continue;
      }
      if (age > 5 * 60_000) {
        await rmdir(lock).catch(() => {});
        continue;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw Object.assign(new Error("JOB_SOURCE_SYNC_BUSY"), {
    code: "JOB_SOURCE_SYNC_BUSY",
  });
}

export function parseGitHubJobLocator(locator: string) {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw Object.assign(new Error("INVALID_JOB_SOURCE"), { code: "INVALID_JOB_SOURCE" });
  }
  const parts = url.pathname.slice(1).split("/");
  const repository = repositorySchema.safeParse(`${url.hostname}/${parts.shift() ?? ""}`);
  const ref = refSchema.safeParse(url.searchParams.get("ref") ?? "");
  const path = pathSchema.safeParse(parts.join("/"));
  if (url.protocol !== "github:" || url.username || url.password ||
      url.hash || !repository.success || !ref.success || !path.success ||
      url.searchParams.size !== 1) {
    throw Object.assign(new Error("INVALID_JOB_SOURCE"), { code: "INVALID_JOB_SOURCE" });
  }
  return {
    locator,
    repository: repository.data,
    ref: ref.data,
    path: path.data,
  };
}

async function makeReadOnly(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      await makeReadOnly(join(path, entry));
    }
  }
  await chmod(path, info.mode & ~0o222);
}

async function immutableSnapshot(checkout: string, commit: string) {
  const snapshots = `${checkout}.snapshots`;
  await privateDirectory(snapshots, true);
  const snapshot = join(snapshots, commit);
  try {
    const info = await lstat(snapshot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw Object.assign(new Error("INVALID_JOB_SOURCE_CHECKOUT"), {
        code: "INVALID_JOB_SOURCE_CHECKOUT",
      });
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) ||
        error.code !== "ENOENT") throw error;
    try {
      await git(["worktree", "add", "--quiet", "--detach", snapshot, commit], checkout);
      await makeReadOnly(snapshot);
    } catch (error) {
      await rm(snapshot, { recursive: true, force: true });
      await git(["worktree", "prune"], checkout).catch(() => {});
      throw error;
    }
  }
  const head = (await git(["rev-parse", "HEAD"], snapshot)).stdout.trim();
  const changes = (await git([
    "status", "--porcelain", "--untracked-files=all",
  ], snapshot)).stdout.trim();
  if (head !== commit || changes) {
    throw Object.assign(new Error("JOB_SOURCE_CHECKOUT_DIRTY"), {
      code: "JOB_SOURCE_CHECKOUT_DIRTY",
    });
  }
  return await realpath(snapshot);
}

async function managedCheckout(agent: string, repository: string, ref: string) {
  const root = await sourceRoot(agent);
  const checkout = join(root, hash([repository, ref]).slice(0, 24));
  return withCheckoutLock(checkout, async () => {
    try {
      const info = await lstat(join(checkout, ".git"));
      if (!info.isDirectory()) throw new Error("INVALID_CHECKOUT");
      const remote = (await git(["remote", "get-url", "origin"], checkout)).stdout.trim();
      if (remote !== `https://github.com/${repository}.git`) {
        throw Object.assign(new Error("JOB_SOURCE_REMOTE_MISMATCH"), {
          code: "JOB_SOURCE_REMOTE_MISMATCH",
        });
      }
    } catch (error) {
      if (error instanceof Error && "code" in error &&
          error.code !== "ENOENT") throw error;
      const temporary = await mkdtemp(join(root, ".clone-"));
      try {
        await git(["init", "--quiet"], temporary);
        await git([
          "remote", "add", "origin", `https://github.com/${repository}.git`,
        ], temporary);
        await rename(temporary, checkout);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    }
    await git(["fetch", "--quiet", "--prune", "origin", ref], checkout);
    await git(["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], checkout);
    await git(["clean", "-ffdx"], checkout);
    const commit = (await git(["rev-parse", "HEAD"], checkout)).stdout.trim();
    return {
      checkout: await immutableSnapshot(checkout, commit),
      commit,
    };
  });
}

async function safeFile(checkout: string, path: string) {
  const candidate = resolve(checkout, path);
  const actual = await realpath(candidate);
  const inside = relative(checkout, actual);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`)) {
    throw Object.assign(new Error("JOB_SOURCE_PATH_ESCAPE"), {
      code: "JOB_SOURCE_PATH_ESCAPE",
    });
  }
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw Object.assign(new Error("INVALID_JOB_SOURCE_FILE"), {
      code: "INVALID_JOB_SOURCE_FILE",
    });
  }
  return actual;
}

export async function resolveGitHubJobSource(
  locator: string,
  agent: string,
): Promise<ResolvedRepositoryJob> {
  const parsedLocator = parseGitHubJobLocator(locator);
  const { checkout, commit } = await managedCheckout(
    agent,
    parsedLocator.repository,
    parsedLocator.ref,
  );
  let definitionPath: string;
  try {
    definitionPath = await safeFile(checkout, parsedLocator.path);
  } catch {
    throw Object.assign(new Error("INVALID_JOB_SOURCE_FILE"), {
      code: "INVALID_JOB_SOURCE_FILE",
    });
  }
  const definition = parseRepositoryJobDefinition(
    await readFile(definitionPath, "utf8"),
  );
  let prompt = definition.prompt;
  if (prompt === undefined) {
    try {
      prompt = await readFile(
        await safeFile(
          checkout,
          join(dirname(parsedLocator.path), definition["prompt-file"]!),
        ),
        "utf8",
      );
    } catch {
      throw Object.assign(new Error("INVALID_JOB_SOURCE_PROMPT"), {
        code: "INVALID_JOB_SOURCE_PROMPT",
      });
    }
  }
  if (!prompt.trim() || prompt.length > 32 * 1024) {
    throw Object.assign(new Error("INVALID_JOB_SOURCE_PROMPT"), {
      code: "INVALID_JOB_SOURCE_PROMPT",
    });
  }
  const resolved: Omit<ResolvedRepositoryJob, "sourceDirectory" | "source"> = {
    id: definition.id,
    prompt,
    ...(definition.schedule
      ? {
          cron: definition.schedule.cron,
          timezone: definition.schedule.timezone,
        }
      : { timezone: "UTC" }),
    requiredTools: definition.execution["required-tools"],
    timeoutMinutes: definition.execution["timeout-minutes"],
    ...(definition.execution["max-ai-credits"] === undefined
      ? {}
      : { maxAiCredits: definition.execution["max-ai-credits"] }),
    workingDirectoryMode: definition.execution["working-directory"],
  };
  return {
    ...resolved,
    sourceDirectory: checkout,
    source: {
      kind: "github" as const,
      ...parsedLocator,
      resolvedCommit: commit,
      definitionFingerprint: hash(resolved),
      lastSyncedAt: new Date().toISOString(),
      checkoutDirectory: checkout,
    },
  };
}

export function parseRepositoryJobDefinition(contents: string) {
  try {
    return repositoryJobSchema.parse(parse(contents));
  } catch {
    throw Object.assign(new Error("INVALID_JOB_SOURCE_DEFINITION"), {
      code: "INVALID_JOB_SOURCE_DEFINITION",
    });
  }
}

export function sourcePolicyAllows(source: GitHubJobSource, resolved: ResolvedRepositoryJob) {
  const allowed = new Set(source.allowedTools);
  return source.workingDirectoryMode === resolved.workingDirectoryMode &&
    (resolved.cron === undefined || source.automaticExecutionAllowed) &&
    resolved.requiredTools.every((tool) => allowed.has(tool)) &&
    resolved.timeoutMinutes <= source.maximumTimeoutMinutes &&
    (source.maximumAiCredits === undefined ||
      (resolved.maxAiCredits !== undefined &&
        resolved.maxAiCredits <= source.maximumAiCredits));
}
