import type { BindingReference } from "./binding-registry.js";
import {
  CloudJobsError,
  bootstrapCloudJobsRepository,
  cancelCloudJobRun,
  changeOwnerCloudJob,
  cloudJobToolInputSchema,
  configureOwnerCloudJobs,
  discoverCloudJobs,
  handleCloudJobTool,
  inspectCloudJob,
  latestOwnerCloudJobResult,
  listCloudJobHistory,
  prepareCloudJob,
  publishOwnerCloudJob,
  registerCloudJobRepository,
  runCloudJobNow,
  checkOwnerCloudJobDrift,
} from "./cloud-jobs.js";
import type { CloudJobToolInput } from "./cloud-jobs.js";
import { LocalJobs } from "./local-jobs.js";
import { isRecord } from "./identity.js";
import { z } from "zod";

export const JOBS_TOOL = "pinocchio_jobs";
const backendSchema = z.enum(["local", "cloud"]);

const jobsInputSchema = z.object({
  action: z.enum([
    "configure", "bootstrap", "preview", "publish", "list", "inspect",
    "history", "latest", "run", "cancel", "change", "drift",
  ]),
  backend: backendSchema.optional(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional(),
  branch: z.string().regex(/^[A-Za-z0-9._/-]+$/).max(200).optional(),
  tokenSecret: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(100).optional(),
  confirmed: z.boolean().optional(),
  id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/).optional()
    .describe("Job ID. Required for inline previews; repository-backed definitions provide their own ID."),
  prompt: z.string().max(32 * 1024).optional()
    .describe("Inline job prompt. Required for inline local previews; do not combine with definition."),
  definition: z.string().max(1_000).optional()
    .describe("GitHub locator for a YAML local-job definition that owns its ID, schedule, execution limits, and prompt or prompt-file. Do not combine with id, prompt, cron, timezone, tools, timeoutMinutes, or maxAiCredits."),
  cron: z.string().optional()
    .describe("Five-field cron expression for inline previews. Repository-backed definitions provide their own schedule."),
  timezone: z.string().max(100).optional()
    .describe("IANA timezone for inline local previews. Repository-backed definitions provide their own timezone."),
  workingDirectory: z.string().optional()
    .describe("Approved local working directory. Required for inline local jobs and repository definitions using subscriber mode."),
  tools: z.array(z.string().min(1).max(200)).max(50).optional()
    .describe("Required tool allowlist for inline previews. Repository-backed definitions provide their own tools."),
  allowUrls: z.array(z.string()).optional(),
  maxAiCredits: z.number().int().min(30).max(100).optional(),
  unlimitedAiCredits: z.boolean().optional(),
  timeoutMinutes: z.number().int().min(1).max(360).optional(),
  retentionDays: z.number().int().min(1).max(90).optional(),
  draftId: z.string().uuid().optional(),
  approvalToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  operation: z.enum(["sync", "pause", "resume", "delete"]).optional(),
  includeResult: z.boolean().optional(),
  runId: z.string().uuid().optional(),
  databaseId: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const jobsToolInputSchema = jobsInputSchema;
const { $schema: _schema, ...extensionJobsToolInputSchema } = z.toJSONSchema(
  jobsInputSchema,
  { io: "input", unrepresentable: "any" },
);
export { extensionJobsToolInputSchema };

const JOB_ERROR_REPAIRS: Record<string, string> = {
  JOB_SOURCE_CONFIGURATION_CONFLICT:
    "A repository-backed YAML definition owns its ID, schedule, prompt, tools, and runtime limits. Call preview with backend, definition, and workingDirectory only, or move the configuration into the YAML definition.",
  INVALID_JOB_SOURCE_DEFINITION:
    "The definition locator must target YAML with version, id, optional schedule, execution, and exactly one of prompt or prompt-file. A Markdown prompt file alone is not a job definition.",
  LOCAL_JOB_PREVIEW_FIELDS_REQUIRED:
    "For an inline local preview provide id, prompt, cron, timezone, and workingDirectory. For a repository-backed preview provide definition and, when it uses subscriber mode, workingDirectory.",
};

export function jobsErrorRepair(code: string) {
  return JOB_ERROR_REPAIRS[code];
}

function requireField<T>(value: T | undefined, code = "INVALID_ARGUMENTS"): T {
  if (value === undefined) throw new CloudJobsError(code);
  return value;
}

function requireConfirmed(value: boolean | undefined) {
  if (value !== true) throw new CloudJobsError("EXPLICIT_CONFIRMATION_REQUIRED");
}

export async function handleJobsTool(
  reference: BindingReference,
  raw: unknown,
  explicitHome?: string,
  localJobs?: LocalJobs,
) {
  const input = jobsInputSchema.parse(raw);
  if (input.backend === "local") {
    if (!localJobs) throw new CloudJobsError("LOCAL_OWNER_SESSION_UNAVAILABLE");
    if (input.action === "preview") {
      if (input.definition && (
        input.id !== undefined || input.prompt !== undefined ||
        input.cron !== undefined || input.timezone !== undefined ||
        input.tools !== undefined || input.timeoutMinutes !== undefined ||
        input.maxAiCredits !== undefined
      )) {
        throw new CloudJobsError("JOB_SOURCE_CONFIGURATION_CONFLICT");
      }
      return localJobs.preview(reference, {
        ...(input.definition
          ? {
              definition: input.definition,
              workingDirectory: input.workingDirectory,
            }
          : {
              id: input.id,
              prompt: input.prompt,
              cron: input.cron,
              timezone: input.timezone ?? "UTC",
              workingDirectory: input.workingDirectory,
              requiredTools: input.tools ?? [],
              timeoutMinutes: input.timeoutMinutes ?? 30,
              ...(input.maxAiCredits === undefined
                ? {}
                : { maxAiCredits: input.maxAiCredits }),
            }),
      });
    }
    if (input.action === "publish") {
      requireConfirmed(input.confirmed);
      return localJobs.publish(
        reference,
        requireField(input.draftId),
        requireField(input.approvalToken),
      );
    }
    if (input.action === "list") {
      return { status: "ready" as const, backend: "local" as const, jobs: localJobs.list(reference) };
    }
    if (input.action === "inspect") {
      return {
        status: "ready" as const,
        backend: "local" as const,
        job: localJobs.inspect(reference, requireField(input.id)),
      };
    }
    if (input.action === "history") {
      return {
        status: "ready" as const,
        backend: "local" as const,
        runs: localJobs.history(reference, requireField(input.id), input.limit ?? 20),
      };
    }
    if (input.action === "latest") {
      return localJobs.latest(
        reference,
        requireField(input.id),
        input.includeResult ?? false,
      );
    }
    if (input.action === "run") {
      requireConfirmed(input.confirmed);
      return localJobs.run(reference, requireField(input.id));
    }
    if (input.action === "cancel") {
      requireConfirmed(input.confirmed);
      return localJobs.cancel(reference, requireField(input.runId));
    }
    if (input.action === "change") {
      requireConfirmed(input.confirmed);
      return localJobs.change(
        reference,
        requireField(input.id),
        requireField(input.operation),
      );
    }
    throw new CloudJobsError("INVALID_ARGUMENTS");
  }
  if (input.action === "configure") {
    requireConfirmed(input.confirmed);
    return configureOwnerCloudJobs(reference, {
      repository: requireField(input.repository),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.tokenSecret ? { tokenSecret: input.tokenSecret } : {}),
    }, explicitHome);
  }
  if (input.action === "bootstrap") {
    requireConfirmed(input.confirmed);
    const repository = requireField(input.repository);
    const result = await bootstrapCloudJobsRepository(
      explicitHome,
      repository,
    );
    await registerCloudJobRepository(reference, {
      repository,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.tokenSecret ? { tokenSecret: input.tokenSecret } : {}),
    }, explicitHome);
    return result;
  }
  if (input.action === "preview") {
    const cloud = cloudJobToolInputSchema.parse({
      action: "preview",
      id: requireField(input.id),
      ...(input.repository ? { repository: input.repository } : {}),
      prompt: requireField(input.prompt),
      cron: requireField(input.cron),
      timezone: input.timezone ?? "UTC",
      tools: input.tools ?? ["*"],
      allowUrls: input.allowUrls ?? [],
      maxAiCredits: input.maxAiCredits ?? 30,
      unlimitedAiCredits: input.unlimitedAiCredits ?? false,
      timeoutMinutes: input.timeoutMinutes ?? 30,
      retentionDays: input.retentionDays ?? 30,
    }) as Extract<CloudJobToolInput, { action: "preview" }>;
    return prepareCloudJob(reference, cloud, explicitHome);
  }
  if (input.action === "publish") {
    requireConfirmed(input.confirmed);
    return publishOwnerCloudJob(
      reference,
      requireField(input.draftId),
      requireField(input.approvalToken),
      explicitHome,
    );
  }
  if (input.action === "list") {
    const local = localJobs
      ? { status: "ready" as const, jobs: localJobs.list(reference) }
      : { status: "unavailable" as const, code: "LOCAL_OWNER_SESSION_UNAVAILABLE" };
    try {
      const cloud = await discoverCloudJobs(reference, explicitHome, input.repository);
      if (input.backend === "cloud") return cloud;
      return {
        status: cloud.status === "ready" && local.status === "ready"
          ? "ready" as const
          : "partial" as const,
        local,
        cloud,
      };
    } catch (error) {
      if (!(error instanceof CloudJobsError)) throw error;
      if (input.backend === "cloud") throw error;
      return {
        status: "partial",
        local,
        cloud: { status: "unavailable", code: error.code },
      };
    }
  }
  if (input.action === "drift") {
    return checkOwnerCloudJobDrift(reference, 0, explicitHome, input.repository);
  }
  if (input.action === "latest") {
    return latestOwnerCloudJobResult(
      reference,
      requireField(input.id),
      input.includeResult ?? false,
      explicitHome,
      input.repository,
    );
  }
  if (input.action === "change") {
    requireConfirmed(input.confirmed);
    return changeOwnerCloudJob(
      reference,
      requireField(input.id),
      requireField(input.operation),
      explicitHome,
      input.approvalToken,
      input.repository,
    );
  }
  if (input.action === "inspect") {
    return inspectCloudJob(
      reference,
      requireField(input.id),
      explicitHome,
      input.repository,
    );
  }
  if (input.action === "history") {
    return listCloudJobHistory(reference, requireField(input.id), {
      ...(input.repository ? { repository: input.repository } : {}),
      limit: input.limit ?? 20,
      includeResults: input.includeResult ?? false,
    }, explicitHome);
  }
  if (input.action === "run") {
    requireConfirmed(input.confirmed);
    return runCloudJobNow(reference, requireField(input.id), {
      ...(input.repository ? { repository: input.repository } : {}),
    }, explicitHome);
  }
  if (input.action === "cancel") {
    requireConfirmed(input.confirmed);
    return cancelCloudJobRun(
      reference,
      requireField(input.id),
      requireField(input.databaseId),
      { ...(input.repository ? { repository: input.repository } : {}) },
      explicitHome,
    );
  }
  return handleCloudJobTool(reference, raw);
}

export function isJobsInput(value: unknown): value is z.infer<typeof jobsInputSchema> {
  return isRecord(value) && typeof value.action === "string";
}
