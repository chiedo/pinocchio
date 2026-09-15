import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isMap, isSeq, parse, parseDocument, stringify } from "yaml";
import { z } from "zod";
import {
  configRootPath,
  loadBinding,
  privateDirectory,
} from "./binding-registry.js";
import type { BindingReference } from "./binding-registry.js";
import { PUBLIC_HOST } from "./release.js";

const exec = promisify(execFile);
const MANAGED_BEGIN = "<!-- pinocchio-memory:v1 -->";
const MANAGED_END = "<!-- /pinocchio-memory:v1 -->";
const PROFILE_LIMIT = 256 * 1024;
const PROMPT_LIMIT = 32 * 1024;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const RESULT_NOTICE_LIMIT = 20;
const RESULT_CHECK_TIMEOUT_MS = 5_000;
const repositorySchema = z.string().regex(
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
);
const branchSchema = z.string().regex(/^[A-Za-z0-9._/-]+$/).max(200);
const secretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(100);
const jobIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,49}$/);
const agentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const cronSchema = z.string().trim().refine((value) => {
  const fields = value.split(/\s+/);
  return fields.length === 5 &&
    fields.every((field) => /^[A-Za-z0-9*,/-]+$/.test(field));
}, "Expected a five-field GitHub Actions cron expression");
const cloudToolSchema = z.enum(["view", "rg", "glob", "web_fetch"]);
const allowedUrlSchema = z.string().max(500).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !/[\s'"]/.test(value);
  } catch {
    return false;
  }
}, "Expected an HTTPS URL without credentials, whitespace, or quotes");
const durationSchema = z.string().regex(/^[1-9]\d*(?:m|h|d)$/);

export const cloudJobsConfigSchema = z.object({
  version: z.literal(1).default(1),
  jobs: z.object({
    provider: z.literal("github-actions"),
    repository: repositorySchema,
    branch: branchSchema.optional(),
    token_secret: secretNameSchema.default("PINOCCHIO_COPILOT_TOKEN"),
    require_approval: z.literal(true),
    agent_sync: z.object({
      check_interval: durationSchema.default("24h"),
      check_on_startup: z.boolean().default(true),
      update_policy: z.literal("require-approval"),
    }).strict(),
  }).strict(),
}).strict();

export type CloudJobsConfig = z.infer<typeof cloudJobsConfigSchema>;

const jobManifestSchema = z.object({
  version: z.literal(1),
  id: jobIdSchema,
  agent: agentIdSchema,
  cron: cronSchema,
  timezone: z.literal("UTC"),
  enabled: z.boolean(),
  tools: z.array(cloudToolSchema).min(1).max(4),
  allowed_urls: z.array(allowedUrlSchema).max(20),
  max_ai_credits: z.number().positive().max(100),
  timeout_minutes: z.number().int().min(1).max(360),
  retention_days: z.number().int().min(1).max(90),
  output: z.literal("github-actions-summary-and-artifact"),
  copilot_version: z.literal(PUBLIC_HOST),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  profile_hash: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type CloudJobManifest = z.infer<typeof jobManifestSchema>;
export type CloudJobDriftResult = Awaited<ReturnType<typeof checkCloudJobDrift>>;

export const cloudJobToolInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("configure"),
    repository: repositorySchema,
    branch: branchSchema.optional(),
    tokenSecret: secretNameSchema.optional(),
    confirmed: z.literal(true),
  }).strict(),
  z.object({
    action: z.literal("bootstrap"),
    confirmed: z.literal(true),
  }).strict(),
  z.object({
    action: z.literal("preview"),
    id: jobIdSchema,
    prompt: z.string().trim().min(1).max(PROMPT_LIMIT),
    cron: cronSchema,
    timezone: z.literal("UTC").default("UTC"),
    tools: z.array(cloudToolSchema).min(1).max(4).default(["view", "rg", "glob"]),
    allowUrls: z.array(allowedUrlSchema).max(20).default([]),
    maxAiCredits: z.number().positive().max(100).default(5),
    timeoutMinutes: z.number().int().min(1).max(360).default(30),
    retentionDays: z.number().int().min(1).max(90).default(30),
  }).strict(),
  z.object({
    action: z.literal("publish"),
    draftId: z.string().uuid(),
    approvalToken: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("drift") }).strict(),
  z.object({
    action: z.literal("change"),
    id: jobIdSchema,
    operation: z.enum(["sync", "pause", "resume", "delete"]),
    approvalToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    confirmed: z.literal(true),
  }).strict(),
  z.object({
    action: z.literal("latest"),
    id: jobIdSchema,
    includeResult: z.boolean().default(false),
  }).strict(),
]);

export type CloudJobToolInput = z.infer<typeof cloudJobToolInputSchema>;

const { $schema: _cloudJobExtensionSchema, ...extensionCloudJobInputSchema } =
  z.toJSONSchema(z.object({
    action: z.enum([
      "configure",
      "bootstrap",
      "preview",
      "publish",
      "list",
      "drift",
      "change",
      "latest",
    ]),
    repository: repositorySchema.optional(),
    branch: branchSchema.optional(),
    tokenSecret: secretNameSchema.optional(),
    confirmed: z.boolean().optional(),
    id: jobIdSchema.optional(),
    prompt: z.string().max(PROMPT_LIMIT).optional(),
    cron: z.string().optional(),
    timezone: z.literal("UTC").optional(),
    tools: z.array(cloudToolSchema).max(4).optional(),
    allowUrls: z.array(allowedUrlSchema).max(20).optional(),
    maxAiCredits: z.number().positive().max(100).optional(),
    timeoutMinutes: z.number().int().min(1).max(360).optional(),
    retentionDays: z.number().int().min(1).max(90).optional(),
    draftId: z.string().uuid().optional(),
    approvalToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    operation: z.enum(["sync", "pause", "resume", "delete"]).optional(),
    includeResult: z.boolean().optional(),
  }).strict(), { io: "input", unrepresentable: "any" });

export { extensionCloudJobInputSchema };

const draftSchema = z.object({
  version: z.literal(1),
  draftId: z.string().uuid(),
  createdAt: z.string().datetime(),
  repository: repositorySchema,
  branch: branchSchema.optional(),
  tokenSecret: secretNameSchema,
  sourceProfile: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  agent: agentIdSchema,
  manifest: jobManifestSchema,
  prompt: z.string().min(1).max(PROMPT_LIMIT),
  profile: z.string().min(1).max(PROFILE_LIMIT),
  workflow: z.string().min(1).max(PROFILE_LIMIT),
  warnings: z.array(z.string()),
  blockers: z.array(z.string()),
  approvalToken: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

type CloudJobDraft = z.infer<typeof draftSchema>;

const repositoryInfoSchema = z.object({
  isPrivate: z.boolean(),
  viewerPermission: z.enum(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]),
  defaultBranchRef: z.object({ name: branchSchema }).nullable(),
}).strict();

export class CloudJobsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CloudJobsError";
  }
}

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function cloudHomePath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return resolve(explicit ?? env.PINOCCHIO_HOME ?? join(homedir(), ".pinocchio"));
}

export function cloudJobsConfigPath(explicitHome?: string) {
  return join(cloudHomePath(explicitHome), "config.yml");
}

function durationMilliseconds(value: string) {
  const match = /^([1-9]\d*)(m|h|d)$/.exec(value);
  if (!match) throw new CloudJobsError("CLOUD_CONFIG_INVALID");
  const amount = Number(match[1]);
  const unit = match[2];
  const duration = amount * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
  if (!Number.isSafeInteger(duration) || duration > 365 * 86_400_000) {
    throw new CloudJobsError("CLOUD_CONFIG_INVALID");
  }
  return duration;
}

async function readPrivateText(path: string, maxBytes: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      info.size > maxBytes || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new CloudJobsError("CLOUD_FILE_UNSAFE");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function writePrivateText(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let moved = false;
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    moved = true;
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle.close();
    if (!moved) await unlink(temporary);
  }
}

async function ensureCloudHome(explicitHome?: string) {
  const root = cloudHomePath(explicitHome);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await privateDirectory(root, false);
  return root;
}

export async function loadCloudJobsConfig(explicitHome?: string) {
  const root = cloudHomePath(explicitHome);
  try {
    await privateDirectory(root, false);
    const text = await readPrivateText(join(root, "config.yml"), 64 * 1024);
    const result = cloudJobsConfigSchema.safeParse(parse(text) as unknown);
    if (!result.success) throw new CloudJobsError("CLOUD_CONFIG_INVALID");
    return result.data;
  } catch (error) {
    if (error instanceof CloudJobsError) throw error;
    if (typeof error === "object" && error !== null && "code" in error &&
        error.code === "ENOENT") {
      throw new CloudJobsError("CLOUD_JOBS_NOT_CONFIGURED");
    }
    throw error;
  }
}

export async function configureCloudJobs(input: {
  repository: string;
  branch?: string;
  tokenSecret?: string;
  cloudHome?: string;
}) {
  const root = await ensureCloudHome(input.cloudHome);
  const config = cloudJobsConfigSchema.parse({
    version: 1,
    jobs: {
      provider: "github-actions",
      repository: input.repository,
      ...(input.branch ? { branch: input.branch } : {}),
      token_secret: input.tokenSecret ?? "PINOCCHIO_COPILOT_TOKEN",
      require_approval: true,
      agent_sync: {
        check_interval: "24h",
        check_on_startup: true,
        update_policy: "require-approval",
      },
    },
  });
  await writePrivateText(
    join(root, "config.yml"),
    stringify(config, { lineWidth: 0 }),
  );
  return {
    status: "configured" as const,
    path: join(root, "config.yml"),
    repository: config.jobs.repository,
    credentialsStored: false,
  };
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; maxBuffer?: number; timeout?: number } = {},
) {
  return exec(command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
    env: process.env,
  });
}

async function repositoryInfo(
  config: CloudJobsConfig,
  timeout = 60_000,
) {
  let result;
  try {
    result = await run("gh", [
      "repo",
      "view",
      config.jobs.repository,
      "--json",
      "isPrivate,viewerPermission,defaultBranchRef",
    ], { timeout });
  } catch {
    throw new CloudJobsError("CLOUD_REPOSITORY_UNAVAILABLE");
  }
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    throw new CloudJobsError("CLOUD_REPOSITORY_INVALID");
  }
  const parsed = repositoryInfoSchema.safeParse(json);
  if (!parsed.success || !parsed.data.isPrivate ||
      !["ADMIN", "MAINTAIN", "WRITE"].includes(parsed.data.viewerPermission)) {
    throw new CloudJobsError("PRIVATE_WRITABLE_REPOSITORY_REQUIRED");
  }
  const defaultBranch = parsed.data.defaultBranchRef?.name;
  if (!defaultBranch) throw new CloudJobsError("CLOUD_REPOSITORY_HAS_NO_DEFAULT_BRANCH");
  if (config.jobs.branch && config.jobs.branch !== defaultBranch) {
    throw new CloudJobsError("CLOUD_JOBS_BRANCH_MUST_BE_DEFAULT");
  }
  return { ...parsed.data, branch: defaultBranch };
}

async function assertTokenAvailable(config: CloudJobsConfig) {
  if (config.jobs.token_secret === "GITHUB_TOKEN") return;
  let output;
  try {
    output = await run("gh", [
      "secret",
      "list",
      "--repo",
      config.jobs.repository,
      "--json",
      "name",
    ]);
  } catch {
    throw new CloudJobsError("CLOUD_TOKEN_SECRET_LOOKUP_FAILED");
  }
  const parsed = z.array(z.object({ name: secretNameSchema }).strict())
    .safeParse(JSON.parse(output.stdout) as unknown);
  if (!parsed.success ||
      !parsed.data.some((secret) => secret.name === config.jobs.token_secret)) {
    throw new CloudJobsError("CLOUD_TOKEN_SECRET_MISSING");
  }
}

export async function bootstrapCloudJobsRepository(explicitHome?: string) {
  const config = await loadCloudJobsConfig(explicitHome);
  try {
    const info = await repositoryInfo(config);
    return {
      status: "ready" as const,
      repository: config.jobs.repository,
      branch: info.branch,
      created: false,
    };
  } catch (error) {
    if (!(error instanceof CloudJobsError) ||
        error.code !== "CLOUD_REPOSITORY_UNAVAILABLE") throw error;
  }
  try {
    await run("gh", [
      "repo",
      "create",
      config.jobs.repository,
      "--private",
      "--add-readme",
      "--description",
      "Private cloud job definitions managed by Pinocchio",
    ]);
  } catch {
    throw new CloudJobsError("CLOUD_REPOSITORY_CREATE_FAILED");
  }
  const info = await repositoryInfo(config);
  return {
    status: "ready" as const,
    repository: config.jobs.repository,
    branch: info.branch,
    created: true,
  };
}

async function withRepository<T>(
  config: CloudJobsConfig,
  operation: (root: string, branch: string) => Promise<T>,
  timeout = 60_000,
) {
  const info = await repositoryInfo(config, timeout);
  const root = await mkdtemp(join(tmpdir(), "pinocchio-cloud-jobs-"));
  try {
    try {
      await run("gh", [
        "repo",
        "clone",
        config.jobs.repository,
        root,
        "--",
        "--depth",
        "1",
        "--branch",
        info.branch,
        "--single-branch",
      ], { timeout });
    } catch {
      throw new CloudJobsError("CLOUD_REPOSITORY_CLONE_FAILED");
    }
    return await operation(root, info.branch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function commitRepository(
  root: string,
  branch: string,
  message: string,
) {
  await run("git", ["add", "--all"], { cwd: root });
  const status = await run("git", ["status", "--porcelain"], { cwd: root });
  if (!status.stdout.trim()) return false;
  await run("git", ["config", "user.name", "Pinocchio"], { cwd: root });
  await run("git", [
    "config",
    "user.email",
    "223556219+Copilot@users.noreply.github.com",
  ], { cwd: root });
  await run("git", ["commit", "-m", message], { cwd: root });
  try {
    await run("git", ["push", "origin", `HEAD:${branch}`], { cwd: root });
  } catch {
    throw new CloudJobsError("CLOUD_REPOSITORY_PUSH_FAILED");
  }
  return true;
}

function parseProfile(text: string) {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)(\r?\n|$)/.exec(text);
  if (!match) throw new CloudJobsError("CLOUD_PROFILE_FRONTMATTER_REQUIRED");
  const document = parseDocument(match[2] ?? "", { uniqueKeys: true });
  if (document.errors.length || !isMap(document.contents)) {
    throw new CloudJobsError("CLOUD_PROFILE_INVALID");
  }
  return {
    document,
    body: text.slice(match[0].length),
    newline: match[1]?.includes("\r") ? "\r\n" : "\n",
  };
}

export function exportCloudAgentProfile(
  text: string,
  requestedTools: z.infer<typeof cloudToolSchema>[],
) {
  if (Buffer.byteLength(text) > PROFILE_LIMIT) {
    throw new CloudJobsError("CLOUD_PROFILE_OVERSIZED");
  }
  const parsed = parseProfile(text);
  const tools = parsed.document.get("tools", true);
  if (!isSeq(tools)) throw new CloudJobsError("CLOUD_PROFILE_TOOLS_REQUIRED");
  const sourceTools = tools.toJSON() as unknown;
  if (!Array.isArray(sourceTools) ||
      sourceTools.some((tool) => typeof tool !== "string")) {
    throw new CloudJobsError("CLOUD_PROFILE_TOOLS_REQUIRED");
  }
  const unavailable = requestedTools.filter((tool) => !sourceTools.includes(tool));
  if (unavailable.length) {
    throw new CloudJobsError("CLOUD_PROFILE_TOOL_NOT_CONFIGURED");
  }
  const warnings: string[] = [];
  for (let index = tools.items.length - 1; index >= 0; index--) tools.delete(index);
  for (const tool of requestedTools) tools.add(tool);
  if (parsed.document.has("skills")) {
    parsed.document.delete("skills");
    warnings.push("Removed local skill configuration from the cloud snapshot.");
  }
  if (parsed.document.has("mcp-servers")) {
    parsed.document.delete("mcp-servers");
    warnings.push("Removed local MCP server configuration from the cloud snapshot.");
  }
  const start = parsed.body.indexOf(MANAGED_BEGIN);
  const finish = parsed.body.indexOf(MANAGED_END);
  if (start === -1 || finish < start ||
      parsed.body.indexOf(MANAGED_BEGIN, start + MANAGED_BEGIN.length) !== -1 ||
      parsed.body.indexOf(MANAGED_END, finish + MANAGED_END.length) !== -1) {
    throw new CloudJobsError("CLOUD_PROFILE_MANAGED_BLOCK_INVALID");
  }
  const authoredBody = (
    parsed.body.slice(0, start) +
    parsed.body.slice(finish + MANAGED_END.length)
  ).replace(/^\s+/, "");
  const blockers = [
    ...authoredBody.matchAll(
      /(?:^|[\s("'`])((?:~\/|\/Users\/|\/home\/)[^\s)"'`]+)/gm,
    ),
  ].map((match) => `Local path reference must be removed or generalized: ${match[1]}`);
  const newline = parsed.newline;
  const profile = `---${newline}${String(parsed.document).trimEnd().replaceAll("\n", newline)}${newline}---${newline}${authoredBody}`;
  return {
    profile,
    warnings,
    blockers: [...new Set(blockers)],
    sourceHash: hash(text),
    profileHash: hash(profile),
  };
}

function workflowFor(
  manifest: CloudJobManifest,
  tokenSecret: string,
) {
  const schedule = manifest.enabled
    ? `  schedule:\n    - cron: '${manifest.cron}'\n`
    : "";
  const available = manifest.tools.map((tool) => `'${tool}'`).join(" ");
  const allowedUrls = manifest.allowed_urls
    .map((url) => `            --allow-url='${url}' \\\n`)
    .join("");
  const tokenExpression = tokenSecret === "GITHUB_TOKEN"
    ? "${{ github.token }}"
    : `\${{ secrets.${tokenSecret} }}`;
  return `name: Pinocchio - ${manifest.id}

on:
  workflow_dispatch:
${schedule}
permissions:
  contents: read

concurrency:
  group: pinocchio-${manifest.id}
  cancel-in-progress: false

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: ${manifest.timeout_minutes}
    steps:
      - name: Check out jobs repository
        uses: actions/checkout@v6
        with:
          persist-credentials: false

      - name: Set up Node.js
        uses: actions/setup-node@v7
        with:
          node-version: 22

      - name: Install Copilot CLI
        run: npm install -g @github/copilot@${manifest.copilot_version}

      - name: Install approved agent snapshot
        run: |
          mkdir -p "$HOME/.copilot/agents"
          install -m 600 ".pinocchio/jobs/${manifest.id}/${manifest.agent}.agent.md" "$HOME/.copilot/agents/${manifest.agent}.agent.md"

      - name: Run approved job
        env:
          COPILOT_GITHUB_TOKEN: ${tokenExpression}
        run: |
          copilot -C ".pinocchio/jobs/${manifest.id}" \\
            -p "$(cat '.pinocchio/jobs/${manifest.id}/prompt.md')" \\
            --agent '${manifest.agent}' \\
            --silent \\
            --no-ask-user \\
            --allow-all-tools \\
            --available-tools ${available} \\
${allowedUrls}\
            --max-ai-credits ${manifest.max_ai_credits} \\
            --secret-env-vars=COPILOT_GITHUB_TOKEN,GITHUB_TOKEN \\
            | tee result.md
          cat result.md >> "$GITHUB_STEP_SUMMARY"

      - name: Store result
        if: always()
        uses: actions/upload-artifact@v6
        with:
          name: pinocchio-${manifest.id}-result
          path: result.md
          if-no-files-found: warn
          retention-days: ${manifest.retention_days}
`;
}

function manifestPath(root: string, id: string) {
  return join(root, ".pinocchio", "jobs", id, "job.yml");
}

function workflowPath(root: string, id: string) {
  return join(root, ".github", "workflows", `pinocchio-${id}.yml`);
}

function jobDirectory(root: string, id: string) {
  return join(root, ".pinocchio", "jobs", id);
}

async function writeJob(root: string, draft: CloudJobDraft) {
  const directory = jobDirectory(root, draft.manifest.id);
  await mkdir(directory, { recursive: true });
  await mkdir(dirname(workflowPath(root, draft.manifest.id)), { recursive: true });
  const existingManifest = manifestPath(root, draft.manifest.id);
  try {
    const current = jobManifestSchema.parse(
      parse(await readFile(existingManifest, "utf8")) as unknown,
    );
    if (current.agent !== draft.manifest.agent) {
      throw new CloudJobsError("CLOUD_JOB_AGENT_CONFLICT");
    }
  } catch (error) {
    if (error instanceof CloudJobsError) throw error;
    if (!(typeof error === "object" && error !== null && "code" in error &&
        error.code === "ENOENT")) {
      throw new CloudJobsError("CLOUD_JOB_MANIFEST_INVALID");
    }
  }
  await writeFile(
    manifestPath(root, draft.manifest.id),
    stringify(draft.manifest, { lineWidth: 0 }),
  );
  await writeFile(join(directory, "prompt.md"), `${draft.prompt.trim()}\n`);
  await writeFile(
    join(directory, `${draft.agent}.agent.md`),
    draft.profile,
  );
  await writeFile(workflowPath(root, draft.manifest.id), draft.workflow);
}

async function storeDraft(draft: CloudJobDraft, explicitHome?: string) {
  const root = await ensureCloudHome(explicitHome);
  const directory = join(root, "drafts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await privateDirectory(directory, false);
  await writePrivateText(
    join(directory, `${draft.draftId}.json`),
    `${JSON.stringify(draft)}\n`,
  );
}

async function readDraft(draftId: string, explicitHome?: string) {
  if (!z.string().uuid().safeParse(draftId).success) {
    throw new CloudJobsError("INVALID_ARGUMENTS");
  }
  const path = join(cloudHomePath(explicitHome), "drafts", `${draftId}.json`);
  let value: unknown;
  try {
    value = JSON.parse(await readPrivateText(path, 1024 * 1024)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new CloudJobsError("CLOUD_DRAFT_INVALID");
    throw error;
  }
  const result = draftSchema.safeParse(value);
  if (!result.success) throw new CloudJobsError("CLOUD_DRAFT_INVALID");
  if (Date.now() - Date.parse(result.data.createdAt) > DRAFT_TTL_MS) {
    throw new CloudJobsError("CLOUD_DRAFT_EXPIRED");
  }
  return { draft: result.data, path };
}

export async function prepareCloudJob(
  reference: BindingReference,
  input: Extract<CloudJobToolInput, { action: "preview" }>,
  explicitHome?: string,
) {
  const { agent, binding } = await boundCloudAgent(reference);
  const config = await loadCloudJobsConfig(explicitHome);
  const source = await readFile(binding.definition.path, "utf8");
  if (input.tools.includes("web_fetch") !== (input.allowUrls.length > 0)) {
    throw new CloudJobsError("CLOUD_WEB_URL_ALLOWLIST_REQUIRED");
  }
  const exported = exportCloudAgentProfile(source, input.tools);
  const prompt = input.prompt.trim();
  const manifest = jobManifestSchema.parse({
    version: 1,
    id: input.id,
    agent,
    cron: input.cron,
    timezone: input.timezone,
    enabled: true,
    tools: input.tools,
    allowed_urls: input.allowUrls,
    max_ai_credits: input.maxAiCredits,
    timeout_minutes: input.timeoutMinutes,
    retention_days: input.retentionDays,
    output: "github-actions-summary-and-artifact",
    copilot_version: PUBLIC_HOST,
    source_hash: exported.sourceHash,
    profile_hash: exported.profileHash,
    prompt_hash: hash(`${prompt}\n`),
  });
  const draftId = randomUUID();
  const createdAt = new Date().toISOString();
  const unsigned = {
    version: 1 as const,
    draftId,
    createdAt,
    repository: config.jobs.repository,
    ...(config.jobs.branch ? { branch: config.jobs.branch } : {}),
    tokenSecret: config.jobs.token_secret,
    sourceProfile: binding.definition.path,
    sourceHash: exported.sourceHash,
    agent,
    manifest,
    prompt,
    profile: exported.profile,
    workflow: workflowFor(manifest, config.jobs.token_secret),
    warnings: exported.warnings,
    blockers: exported.blockers,
  };
  const approvalToken = hash(JSON.stringify(unsigned));
  const draft = draftSchema.parse({ ...unsigned, approvalToken });
  await storeDraft(draft, explicitHome);
  return {
    status: draft.blockers.length ? "blocked" as const : "approval-required" as const,
    draftId,
    approvalToken,
    expiresAt: new Date(Date.parse(createdAt) + DRAFT_TTL_MS).toISOString(),
    repository: draft.repository,
    sourceProfile: draft.sourceProfile,
    manifest: draft.manifest,
    warnings: draft.warnings,
    blockers: draft.blockers,
    exactUpload: {
      prompt: `${draft.prompt}\n`,
      profile: draft.profile,
      workflow: draft.workflow,
      manifest: stringify(draft.manifest, { lineWidth: 0 }),
    },
  };
}

export async function publishCloudJob(
  draftId: string,
  approvalToken: string,
  explicitHome?: string,
) {
  const { draft, path } = await readDraft(draftId, explicitHome);
  if (draft.approvalToken !== approvalToken ||
      hash(JSON.stringify({
        version: draft.version,
        draftId: draft.draftId,
        createdAt: draft.createdAt,
        repository: draft.repository,
        ...(draft.branch ? { branch: draft.branch } : {}),
        tokenSecret: draft.tokenSecret,
        sourceProfile: draft.sourceProfile,
        sourceHash: draft.sourceHash,
        agent: draft.agent,
        manifest: draft.manifest,
        prompt: draft.prompt,
        profile: draft.profile,
        workflow: draft.workflow,
        warnings: draft.warnings,
        blockers: draft.blockers,
      })) !== approvalToken) {
    throw new CloudJobsError("CLOUD_DRAFT_APPROVAL_MISMATCH");
  }
  if (draft.blockers.length) throw new CloudJobsError("CLOUD_DRAFT_BLOCKED");
  const config = await loadCloudJobsConfig(explicitHome);
  if (config.jobs.repository !== draft.repository ||
      config.jobs.branch !== draft.branch ||
      config.jobs.token_secret !== draft.tokenSecret) {
    throw new CloudJobsError("CLOUD_CONFIG_CHANGED_AFTER_PREVIEW");
  }
  await assertTokenAvailable(config);
  const source = await readFile(draft.sourceProfile, "utf8");
  if (hash(source) !== draft.sourceHash) {
    throw new CloudJobsError("CLOUD_PROFILE_CHANGED_AFTER_PREVIEW");
  }
  const changed = await withRepository(config, async (root, branch) => {
    await writeJob(root, draft);
    return commitRepository(
      root,
      branch,
      `Publish Pinocchio job ${draft.manifest.id}`,
    );
  });
  await unlink(path);
  return {
    status: changed ? "published" as const : "unchanged" as const,
    job: draft.manifest,
    workflowUrl: `https://github.com/${draft.repository}/actions/workflows/pinocchio-${draft.manifest.id}.yml`,
  };
}

async function readRemoteJobs(root: string) {
  const directory = join(root, ".pinocchio", "jobs");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
        error.code === "ENOENT") return [];
    throw error;
  }
  const jobs: CloudJobManifest[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !jobIdSchema.safeParse(entry.name).success) continue;
    try {
      jobs.push(jobManifestSchema.parse(
        parse(await readFile(manifestPath(root, entry.name), "utf8")) as unknown,
      ));
    } catch {
      throw new CloudJobsError("CLOUD_JOB_MANIFEST_INVALID");
    }
  }
  return jobs;
}

export async function listCloudJobs(explicitHome?: string) {
  const config = await loadCloudJobsConfig(explicitHome);
  const jobs = await withRepository(config, (root) => readRemoteJobs(root));
  return {
    status: "ready" as const,
    repository: config.jobs.repository,
    jobs: jobs.map((job) => ({
      ...job,
      workflowUrl: `https://github.com/${config.jobs.repository}/actions/workflows/pinocchio-${job.id}.yml`,
    })),
  };
}

function conciseDiff(published: string, local: string) {
  const before = published.split("\n");
  const after = local.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length &&
      before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const contextStart = Math.max(0, prefix - 3);
  const beforeEnd = Math.min(before.length, before.length - suffix + 3);
  const afterEnd = Math.min(after.length, after.length - suffix + 3);
  const lines = [
    "--- published",
    "+++ local-cloud-safe",
    `@@ -${contextStart + 1},${beforeEnd - contextStart} +${contextStart + 1},${afterEnd - contextStart} @@`,
    ...before.slice(contextStart, prefix).map((line) => ` ${line}`),
    ...before.slice(prefix, before.length - suffix).map((line) => `-${line}`),
    ...after.slice(prefix, after.length - suffix).map((line) => `+${line}`),
    ...after.slice(after.length - suffix, afterEnd).map((line) => ` ${line}`),
  ];
  const result = lines.join("\n");
  return result.length <= 32 * 1024
    ? result
    : `${result.slice(0, 32 * 1024)}\n... diff truncated ...`;
}

export async function checkCloudJobDrift(
  configRoot = configRootPath(),
  explicitHome?: string,
) {
  const config = await loadCloudJobsConfig(explicitHome);
  const results = await withRepository(config, async (root) => {
    const jobs = await readRemoteJobs(root);
    return Promise.all(jobs.map(async (job) => {
      const publishedPath = join(jobDirectory(root, job.id), `${job.agent}.agent.md`);
      let published: string;
      try {
        published = await readFile(publishedPath, "utf8");
      } catch {
        return { id: job.id, agent: job.agent, status: "published-profile-missing" as const };
      }
      if (hash(published) !== job.profile_hash) {
        return {
          id: job.id,
          agent: job.agent,
          status: "remote-drift" as const,
          publishedHash: hash(published),
          expectedHash: job.profile_hash,
        };
      }

      const sourcePath = join(configRoot, "agents", `${job.agent}.agent.md`);
      let source: string;
      try {
        source = await readFile(sourcePath, "utf8");
      } catch {
        return {
          id: job.id,
          agent: job.agent,
          sourceProfile: sourcePath,
          status: "local-profile-missing" as const,
        };
      }
      let exported;
      try {
        exported = exportCloudAgentProfile(source, job.tools);
      } catch (error) {
        return {
          id: job.id,
          agent: job.agent,
          sourceProfile: sourcePath,
          status: "local-profile-invalid" as const,
          code: error instanceof CloudJobsError ? error.code : "CLOUD_PROFILE_INVALID",
        };
      }
      if (exported.blockers.length) {
        return {
          id: job.id,
          agent: job.agent,
          sourceProfile: sourcePath,
          status: "local-profile-blocked" as const,
          blockers: exported.blockers,
        };
      }
      if (exported.profileHash === job.profile_hash &&
          exported.sourceHash === job.source_hash) {
        return {
          id: job.id,
          agent: job.agent,
          sourceProfile: sourcePath,
          status: "in-sync" as const,
        };
      }
      return {
        id: job.id,
        agent: job.agent,
        sourceProfile: sourcePath,
        status: "source-drift" as const,
        sourceHash: exported.sourceHash,
        publishedSourceHash: job.source_hash,
        diff: conciseDiff(published, exported.profile),
        approvalToken: hash(JSON.stringify({
          version: 1,
          action: "sync",
          repository: config.jobs.repository,
          id: job.id,
          publishedProfileHash: job.profile_hash,
          sourceHash: exported.sourceHash,
          profileHash: exported.profileHash,
        })),
      };
    }));
  });
  return {
    status: "checked" as const,
    repository: config.jobs.repository,
    checkedAt: new Date().toISOString(),
    drifted: results.filter((result) => result.status !== "in-sync").length,
    jobs: results,
  };
}

function isCloudJobDriftResult(value: unknown): value is CloudJobDriftResult {
  return typeof value === "object" && value !== null &&
    "status" in value && value.status === "checked" &&
    "checkedAt" in value && typeof value.checkedAt === "string" &&
    "repository" in value && typeof value.repository === "string" &&
    "drifted" in value && typeof value.drifted === "number" &&
    "jobs" in value && Array.isArray(value.jobs);
}

async function readDriftCache(root: string) {
  try {
    const value = JSON.parse(
      await readPrivateText(join(root, "drift-state.json"), 1024 * 1024),
    ) as unknown;
    if (typeof value !== "object" || value === null ||
        !("checkedAt" in value) || typeof value.checkedAt !== "string" ||
        !("result" in value) || !isCloudJobDriftResult(value.result)) return;
    return { checkedAt: Date.parse(value.checkedAt), result: value.result };
  } catch (error) {
    if (error instanceof SyntaxError ||
        (typeof error === "object" && error !== null && "code" in error &&
          error.code === "ENOENT")) return;
    throw error;
  }
}

async function acquireDriftLock(root: string) {
  return acquireCloudLock(root, "drift");
}

async function acquireCloudLock(root: string, name: string) {
  const path = join(root, `${name}.lock`);
  const create = () => open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    return { path, handle: await create() };
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error &&
        error.code === "EEXIST")) throw error;
  }
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() ||
        Date.now() - info.mtimeMs <= 15 * 60 * 1000) return;
    await unlink(path);
    return { path, handle: await create() };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
        ["ENOENT", "EEXIST"].includes(String(error.code))) return;
    throw error;
  }
}

async function checkCloudJobDriftDue(
  configRoot: string,
  minimumAgeMs: number,
  explicitHome?: string,
) {
  const root = await ensureCloudHome(explicitHome);
  const config = await loadCloudJobsConfig(explicitHome);
  const found = await readDriftCache(root);
  const cached = found?.result.repository === config.jobs.repository ? found : undefined;
  if (cached && Date.now() - cached.checkedAt < minimumAgeMs) {
    return cached.result;
  }
  const lock = await acquireDriftLock(root);
  if (!lock) return cached?.result;
  try {
    const afterLock = await readDriftCache(root);
    if (afterLock && Date.now() - afterLock.checkedAt < minimumAgeMs) {
      return afterLock.result;
    }
    const result = await checkCloudJobDrift(configRoot, explicitHome);
    await writePrivateText(
      join(root, "drift-state.json"),
      `${JSON.stringify({
        version: 1,
        checkedAt: result.checkedAt,
        result,
      })}\n`,
    );
    return result;
  } finally {
    await lock.handle.close();
    await unlink(lock.path);
  }
}

export async function changeCloudJob(
  id: string,
  operation: "sync" | "pause" | "resume" | "delete",
  configRoot = configRootPath(),
  explicitHome?: string,
  approvalToken?: string,
) {
  if (!jobIdSchema.safeParse(id).success ||
      !["sync", "pause", "resume", "delete"].includes(operation)) {
    throw new CloudJobsError("INVALID_ARGUMENTS");
  }
  const config = await loadCloudJobsConfig(explicitHome);
  return withRepository(config, async (root, branch) => {
    let manifest: CloudJobManifest;
    try {
      manifest = jobManifestSchema.parse(
        parse(await readFile(manifestPath(root, id), "utf8")) as unknown,
      );
    } catch {
      throw new CloudJobsError("CLOUD_JOB_NOT_FOUND");
    }
    if (operation === "delete") {
      await rm(jobDirectory(root, id), { recursive: true });
      await rm(workflowPath(root, id), { force: true });
    } else if (operation === "sync") {
      const publishedPath = join(jobDirectory(root, id), `${manifest.agent}.agent.md`);
      const published = await readFile(publishedPath, "utf8");
      if (hash(published) !== manifest.profile_hash) {
        throw new CloudJobsError("CLOUD_REMOTE_PROFILE_CHANGED");
      }
      const sourcePath = join(configRoot, "agents", `${manifest.agent}.agent.md`);
      const source = await readFile(sourcePath, "utf8");
      const exported = exportCloudAgentProfile(source, manifest.tools);
      if (exported.blockers.length) {
        throw new CloudJobsError("CLOUD_PROFILE_HAS_LOCAL_DEPENDENCIES");
      }
      const expectedApproval = hash(JSON.stringify({
        version: 1,
        action: "sync",
        repository: config.jobs.repository,
        id,
        publishedProfileHash: manifest.profile_hash,
        sourceHash: exported.sourceHash,
        profileHash: exported.profileHash,
      }));
      if (approvalToken !== expectedApproval) {
        throw new CloudJobsError("CLOUD_SYNC_APPROVAL_MISMATCH");
      }
      manifest = jobManifestSchema.parse({
        ...manifest,
        source_hash: exported.sourceHash,
        profile_hash: exported.profileHash,
      });
      await writeFile(publishedPath, exported.profile);
      await writeFile(
        manifestPath(root, id),
        stringify(manifest, { lineWidth: 0 }),
      );
    } else {
      manifest = jobManifestSchema.parse({
        ...manifest,
        enabled: operation === "resume",
      });
      await writeFile(
        manifestPath(root, id),
        stringify(manifest, { lineWidth: 0 }),
      );
      await writeFile(
        workflowPath(root, id),
        workflowFor(manifest, config.jobs.token_secret),
      );
    }
    const changed = await commitRepository(
      root,
      branch,
      `${operation[0]?.toUpperCase()}${operation.slice(1)} Pinocchio job ${id}`,
    );
    return {
      status: changed ? operation : "unchanged",
      id,
      repository: config.jobs.repository,
    };
  });
}

const runSchema = z.object({
  databaseId: z.number().int(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string().url(),
  createdAt: z.string(),
  updatedAt: z.string(),
  displayTitle: z.string(),
  workflowName: z.string(),
}).strict();

const resultStateEntrySchema = z.object({
  notifiedThrough: z.number().int().nonnegative(),
  readThrough: z.number().int().nonnegative(),
}).strict();

const resultStateSchema = z.object({
  version: z.literal(1),
  repository: repositorySchema,
  jobs: z.record(jobIdSchema, resultStateEntrySchema),
}).strict();

type ResultState = z.infer<typeof resultStateSchema>;

function emptyResultState(repository: string): ResultState {
  return { version: 1, repository, jobs: {} };
}

async function readResultState(root: string, repository: string) {
  try {
    const parsed = resultStateSchema.safeParse(JSON.parse(
      await readPrivateText(join(root, "result-state.json"), 1024 * 1024),
    ) as unknown);
    if (!parsed.success) throw new CloudJobsError("CLOUD_RESULT_STATE_INVALID");
    return parsed.data.repository === repository
      ? parsed.data
      : emptyResultState(repository);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CloudJobsError("CLOUD_RESULT_STATE_INVALID");
    }
    if (typeof error === "object" && error !== null && "code" in error &&
        error.code === "ENOENT") {
      return emptyResultState(repository);
    }
    throw error;
  }
}

async function writeResultState(root: string, state: ResultState) {
  await writePrivateText(
    join(root, "result-state.json"),
    `${JSON.stringify(state)}\n`,
  );
}

async function listCloudJobRuns(
  config: CloudJobsConfig,
  options: {
    id?: string;
    limit: number;
    timeout?: number;
  },
) {
  let output;
  try {
    output = await run("gh", [
      "run",
      "list",
      "--repo",
      config.jobs.repository,
      ...(options.id
        ? ["--workflow", `pinocchio-${options.id}.yml`]
        : []),
      "--limit",
      String(options.limit),
      "--json",
      "databaseId,status,conclusion,url,createdAt,updatedAt,displayTitle,workflowName",
    ], options.timeout === undefined ? {} : { timeout: options.timeout });
  } catch {
    throw new CloudJobsError("CLOUD_JOB_RUN_LOOKUP_FAILED");
  }
  let json: unknown;
  try {
    json = JSON.parse(output.stdout) as unknown;
  } catch {
    throw new CloudJobsError("CLOUD_JOB_RUN_INVALID");
  }
  const parsed = z.array(runSchema).safeParse(json);
  if (!parsed.success) throw new CloudJobsError("CLOUD_JOB_RUN_INVALID");
  return parsed.data;
}

async function boundCloudAgent(reference: BindingReference) {
  const binding = await loadBinding(reference);
  const agent = basename(binding.definition.path, ".agent.md");
  if (!agentIdSchema.safeParse(agent).success ||
      binding.definition.path !== join(reference.configRoot, "agents", `${agent}.agent.md`)) {
    throw new CloudJobsError("CLOUD_PROFILE_SOURCE_INVALID");
  }
  return { agent, binding };
}

export async function checkCloudJobResultNotices(
  reference: BindingReference,
  explicitHome?: string,
) {
  const { agent } = await boundCloudAgent(reference);
  const config = await loadCloudJobsConfig(explicitHome);
  const jobs = await withRepository(
    config,
    (root) => readRemoteJobs(root),
    RESULT_CHECK_TIMEOUT_MS,
  );
  const ids = new Set(jobs
    .filter((job) => job.agent === agent)
    .map((job) => job.id));
  const runs = ids.size
    ? await listCloudJobRuns(config, {
        limit: Math.min(100, Math.max(RESULT_NOTICE_LIMIT, ids.size * RESULT_NOTICE_LIMIT)),
        timeout: RESULT_CHECK_TIMEOUT_MS,
      })
    : [];
  const completed = runs.flatMap((run) => {
    const prefix = "Pinocchio - ";
    const id = run.workflowName.startsWith(prefix)
      ? run.workflowName.slice(prefix.length)
      : "";
    return run.status === "completed" && ids.has(id)
      ? [{ id, run }]
      : [];
  });

  const root = await ensureCloudHome(explicitHome);
  const lock = await acquireCloudLock(root, "result-state");
  if (!lock) {
    return {
      status: "busy" as const,
      agent,
      repository: config.jobs.repository,
    };
  }
  try {
    const state = await readResultState(root, config.jobs.repository);
    const fresh = completed.filter(({ id, run }) =>
      run.databaseId > (state.jobs[id]?.notifiedThrough ?? 0));
    if (!fresh.length) {
      return {
        status: "ready" as const,
        agent,
        repository: config.jobs.repository,
        checkedAt: new Date().toISOString(),
        runs: [],
        omitted: 0,
      };
    }
    const ordered = fresh.sort((left, right) =>
      Date.parse(right.run.updatedAt) - Date.parse(left.run.updatedAt));
    return {
      status: "ready" as const,
      agent,
      repository: config.jobs.repository,
      checkedAt: new Date().toISOString(),
      runs: ordered.slice(0, RESULT_NOTICE_LIMIT),
      omitted: Math.max(0, ordered.length - RESULT_NOTICE_LIMIT),
    };
  } finally {
    await lock.handle.close();
    await unlink(lock.path);
  }
}

export type CloudJobResultNoticeResult =
  Awaited<ReturnType<typeof checkCloudJobResultNotices>>;

export async function markCloudJobResultNotices(
  result: CloudJobResultNoticeResult,
  explicitHome?: string,
) {
  if (result.status !== "ready" || !result.runs.length) return;
  const config = await loadCloudJobsConfig(explicitHome);
  if (config.jobs.repository !== result.repository) {
    throw new CloudJobsError("CLOUD_RESULT_STATE_REPOSITORY_MISMATCH");
  }
  const root = await ensureCloudHome(explicitHome);
  const lock = await acquireCloudLock(root, "result-state");
  if (!lock) throw new CloudJobsError("CLOUD_RESULT_STATE_BUSY");
  try {
    const state = await readResultState(root, config.jobs.repository);
    for (const { id, run } of result.runs) {
      const previous = state.jobs[id] ?? {
        notifiedThrough: 0,
        readThrough: 0,
      };
      state.jobs[id] = {
        ...previous,
        notifiedThrough: Math.max(previous.notifiedThrough, run.databaseId),
      };
    }
    await writeResultState(root, state);
  } finally {
    await lock.handle.close();
    await unlink(lock.path);
  }
}

export function formatCloudJobResultNotices(
  result: CloudJobResultNoticeResult,
) {
  if (result.status !== "ready" || !result.runs.length) return "";
  const items = result.runs.map(({ id, run }) =>
    `- ${id}: ${run.conclusion ?? "completed"} at ${run.updatedAt} (${run.url})`);
  if (result.omitted) {
    items.push(`- ${result.omitted} additional completed run(s) omitted to avoid flooding.`);
  }
  return `Pinocchio cloud job results (trusted cloud status, not memory):
${items.join("\n")}
Tell the user about these new results. To retrieve a full latest result, use ${CLOUD_JOBS_TOOL} with action=latest, the job id, and includeResult=true. Do not save notices or cloud results to memory automatically.
`;
}

async function markCloudJobRunRead(
  config: CloudJobsConfig,
  id: string,
  databaseId: number,
  explicitHome?: string,
) {
  const root = await ensureCloudHome(explicitHome);
  const lock = await acquireCloudLock(root, "result-state");
  if (!lock) throw new CloudJobsError("CLOUD_RESULT_STATE_BUSY");
  try {
    const state = await readResultState(root, config.jobs.repository);
    const previous = state.jobs[id] ?? {
      notifiedThrough: 0,
      readThrough: 0,
    };
    state.jobs[id] = {
      notifiedThrough: Math.max(previous.notifiedThrough, databaseId),
      readThrough: Math.max(previous.readThrough, databaseId),
    };
    await writeResultState(root, state);
  } finally {
    await lock.handle.close();
    await unlink(lock.path);
  }
}

export async function latestCloudJobResult(
  id: string,
  includeResult: boolean,
  explicitHome?: string,
) {
  if (!jobIdSchema.safeParse(id).success) {
    throw new CloudJobsError("INVALID_ARGUMENTS");
  }
  const config = await loadCloudJobsConfig(explicitHome);
  await repositoryInfo(config);
  const latest = (await listCloudJobRuns(config, { id, limit: 1 }))[0];
  if (!latest) return { status: "no-runs" as const, id };
  if (!includeResult || latest.status !== "completed") {
    return { status: "ready" as const, id, run: latest };
  }
  const root = await mkdtemp(join(tmpdir(), "pinocchio-cloud-result-"));
  try {
    try {
      await run("gh", [
        "run",
        "download",
        String(latest.databaseId),
        "--repo",
        config.jobs.repository,
        "--name",
        `pinocchio-${id}-result`,
        "--dir",
        root,
      ]);
    } catch {
      throw new CloudJobsError("CLOUD_JOB_RESULT_UNAVAILABLE");
    }
    const result = await readFile(join(root, "result.md"), "utf8");
    if (Buffer.byteLength(result) > 256 * 1024) {
      throw new CloudJobsError("CLOUD_JOB_RESULT_OVERSIZED");
    }
    await markCloudJobRunRead(config, id, latest.databaseId, explicitHome);
    return { status: "ready" as const, id, run: latest, result };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function startCloudJobDriftMonitor(
  configRoot: string,
  onResult: (result: CloudJobDriftResult | {
    status: "unavailable";
    code: string;
  }) => void,
  explicitHome?: string,
) {
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const check = async (minimumAgeMs: number) => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await checkCloudJobDriftDue(
        configRoot,
        minimumAgeMs,
        explicitHome,
      );
      if (result) onResult(result);
    } catch (error) {
      const code = error instanceof CloudJobsError
        ? error.code
        : "CLOUD_DRIFT_CHECK_FAILED";
      if (code !== "CLOUD_JOBS_NOT_CONFIGURED") {
        onResult({ status: "unavailable", code });
      }
    } finally {
      running = false;
    }
  };
  void loadCloudJobsConfig(explicitHome).then((config) => {
    if (stopped) return;
    const interval = durationMilliseconds(config.jobs.agent_sync.check_interval);
    if (config.jobs.agent_sync.check_on_startup) void check(Math.min(interval, 5 * 60 * 1000));
    timer = setInterval(
      () => { void check(interval); },
      interval,
    );
    timer.unref();
  }).catch((error: unknown) => {
    if (error instanceof CloudJobsError &&
        error.code === "CLOUD_JOBS_NOT_CONFIGURED") return;
    onResult({
      status: "unavailable",
      code: error instanceof CloudJobsError ? error.code : "CLOUD_CONFIG_INVALID",
    });
  });
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

export async function handleCloudJobTool(
  reference: BindingReference,
  raw: unknown,
) {
  const input = cloudJobToolInputSchema.parse(raw);
  switch (input.action) {
    case "configure":
      return configureCloudJobs({
        repository: input.repository,
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.tokenSecret ? { tokenSecret: input.tokenSecret } : {}),
      });
    case "bootstrap":
      return bootstrapCloudJobsRepository();
    case "preview":
      return prepareCloudJob(reference, input);
    case "publish":
      return publishCloudJob(input.draftId, input.approvalToken);
    case "list":
      return listCloudJobs();
    case "drift":
      return checkCloudJobDrift(reference.configRoot);
    case "change":
      return changeCloudJob(
        input.id,
        input.operation,
        reference.configRoot,
        undefined,
        input.approvalToken,
      );
    case "latest":
      return latestCloudJobResult(input.id, input.includeResult);
  }
}

export const CLOUD_JOBS_TOOL = "pinocchio_cloud_jobs";
