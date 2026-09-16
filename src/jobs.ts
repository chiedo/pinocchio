import type { BindingReference } from "./binding-registry.js";
import {
  CloudJobsError,
  checkCloudJobDrift,
  changeCloudJob,
  cloudJobToolInputSchema,
  configureCloudJobs,
  handleCloudJobTool,
  latestCloudJobResult,
  listCloudJobs,
  prepareCloudJob,
  publishCloudJob,
} from "./cloud-jobs.js";
import type { CloudJobToolInput } from "./cloud-jobs.js";
import { localJobsUnavailable } from "./jobs-compatibility.js";
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
  id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/).optional(),
  prompt: z.string().max(32 * 1024).optional(),
  cron: z.string().optional(),
  timezone: z.literal("UTC").optional(),
  tools: z.array(z.enum(["*", "view", "rg", "glob", "web_fetch"])).optional(),
  allowUrls: z.array(z.string()).optional(),
  maxAiCredits: z.number().int().min(30).max(100).optional(),
  unlimitedAiCredits: z.boolean().optional(),
  timeoutMinutes: z.number().int().min(1).max(360).optional(),
  retentionDays: z.number().int().min(1).max(90).optional(),
  draftId: z.string().uuid().optional(),
  approvalToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  operation: z.enum(["sync", "pause", "resume", "delete"]).optional(),
  includeResult: z.boolean().optional(),
}).strict();

export const jobsToolInputSchema = jobsInputSchema;
const { $schema: _schema, ...extensionJobsToolInputSchema } = z.toJSONSchema(
  jobsInputSchema,
  { io: "input", unrepresentable: "any" },
);
export { extensionJobsToolInputSchema };

function requireField<T>(value: T | undefined, code = "INVALID_ARGUMENTS"): T {
  if (value === undefined) throw new CloudJobsError(code);
  return value;
}

function localResult(input: z.infer<typeof jobsInputSchema>) {
  if (input.action === "list" || input.action === "inspect" ||
      input.action === "history" || input.action === "latest") {
    return localJobsUnavailable();
  }
  return {
    ...localJobsUnavailable(),
    action: input.action,
    blockers: ["LOCAL_BACKGROUND_TASK_API_UNAVAILABLE"],
  };
}

export async function handleJobsTool(
  reference: BindingReference,
  raw: unknown,
  explicitHome?: string,
) {
  const input = jobsInputSchema.parse(raw);
  if (input.backend === "local") return localResult(input);
  if (input.action === "configure") {
    return configureCloudJobs({
      repository: requireField(input.repository),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.tokenSecret ? { tokenSecret: input.tokenSecret } : {}),
      ...(explicitHome ? { cloudHome: explicitHome } : {}),
    });
  }
  if (input.action === "bootstrap") {
    return (await import("./cloud-jobs.js")).bootstrapCloudJobsRepository(
      explicitHome,
      input.repository,
    );
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
    return publishCloudJob(requireField(input.draftId), requireField(input.approvalToken), explicitHome);
  }
  if (input.action === "list") {
    try {
      const cloud = await listCloudJobs(explicitHome, input.repository);
      return { status: "ready", local: localJobsUnavailable(), cloud };
    } catch (error) {
      if (!(error instanceof CloudJobsError)) throw error;
      return {
        status: "partial",
        local: localJobsUnavailable(),
        cloud: { status: "unavailable", code: error.code },
      };
    }
  }
  if (input.action === "drift") {
    return checkCloudJobDrift(reference.configRoot, explicitHome, input.repository);
  }
  if (input.action === "latest") {
    return latestCloudJobResult(
      requireField(input.id),
      input.includeResult ?? false,
      explicitHome,
      input.repository,
    );
  }
  if (input.action === "change") {
    return changeCloudJob(
      requireField(input.id),
      requireField(input.operation),
      reference.configRoot,
      explicitHome,
      input.approvalToken,
      input.repository,
    );
  }
  if (input.action === "inspect" || input.action === "history" ||
      input.action === "run" || input.action === "cancel") {
    return {
      ...localJobsUnavailable(),
      backend: input.backend ?? "cloud",
      action: input.action,
      detail: "This operation is not yet exposed by the current cloud adapter.",
    };
  }
  return handleCloudJobTool(reference, raw);
}

export function isJobsInput(value: unknown): value is z.infer<typeof jobsInputSchema> {
  return isRecord(value) && typeof value.action === "string";
}
