import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  bindingForDefinition,
  configRootPath,
} from "./binding-registry.js";
import {
  bootstrapCloudJobsRepository,
  changeCloudJob,
  checkCloudJobDrift,
  CloudJobsError,
  cloudJobToolInputSchema,
  configureCloudJobs,
  latestCloudJobResult,
  listCloudJobs,
  prepareCloudJob,
  publishCloudJob,
} from "./cloud-jobs.js";
import { isRecord } from "./identity.js";

function confirmed(value: boolean | undefined) {
  if (!value) throw new CloudJobsError("EXPLICIT_CONFIRMATION_REQUIRED");
}

export async function main(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      "config-root": { type: "string" },
      "pinocchio-home": { type: "string" },
      repository: { type: "string" },
      branch: { type: "string" },
      "token-secret": { type: "string" },
      agent: { type: "string" },
      id: { type: "string" },
      "prompt-file": { type: "string" },
      cron: { type: "string" },
      tool: { type: "string", multiple: true },
      "allow-url": { type: "string", multiple: true },
      "max-ai-credits": { type: "string" },
      "unlimited-ai-credits": { type: "boolean" },
      "timeout-minutes": { type: "string" },
      "retention-days": { type: "string" },
      draft: { type: "string" },
      "approval-token": { type: "string" },
      operation: { type: "string" },
      "include-result": { type: "boolean" },
      confirm: { type: "boolean" },
    },
  });
  if (positionals.length !== 1) throw new CloudJobsError("INVALID_ARGUMENTS");
  const command = positionals[0];
  const configRoot = configRootPath(values["config-root"]);
  const home = values["pinocchio-home"];
  if (command === "configure") {
    confirmed(values.confirm);
    if (!values.repository) throw new CloudJobsError("INVALID_ARGUMENTS");
    return configureCloudJobs({
      repository: values.repository,
      ...(values.branch ? { branch: values.branch } : {}),
      ...(values["token-secret"] ? { tokenSecret: values["token-secret"] } : {}),
      ...(home ? { cloudHome: home } : {}),
    });
  }
  if (command === "bootstrap") {
    confirmed(values.confirm);
    return bootstrapCloudJobsRepository(home);
  }
  if (command === "preview") {
    if (!values.agent || !values.id || !values["prompt-file"] || !values.cron) {
      throw new CloudJobsError("INVALID_ARGUMENTS");
    }
    if (values["unlimited-ai-credits"] && values["max-ai-credits"]) {
      throw new CloudJobsError("INVALID_ARGUMENTS");
    }
    const reference = await bindingForDefinition(
      configRoot,
      join(configRoot, "agents", `${values.agent}.agent.md`),
    );
    if (!reference) throw new CloudJobsError("AGENT_NOT_INSTALLED");
    const prompt = await readFile(values["prompt-file"], "utf8");
    const input = cloudJobToolInputSchema.parse({
      action: "preview",
      id: values.id,
      prompt,
      cron: values.cron,
      timezone: "UTC",
      tools: values.tool ?? ["view", "rg", "glob"],
      allowUrls: values["allow-url"] ?? [],
      maxAiCredits: Number(values["max-ai-credits"] ?? 30),
      unlimitedAiCredits: values["unlimited-ai-credits"] ?? false,
      timeoutMinutes: Number(values["timeout-minutes"] ?? 30),
      retentionDays: Number(values["retention-days"] ?? 30),
    });
    if (input.action !== "preview") throw new CloudJobsError("INVALID_ARGUMENTS");
    return prepareCloudJob(reference, input, home);
  }
  if (command === "publish") {
    confirmed(values.confirm);
    if (!values.draft || !values["approval-token"]) {
      throw new CloudJobsError("INVALID_ARGUMENTS");
    }
    return publishCloudJob(values.draft, values["approval-token"], home);
  }
  if (command === "list") return listCloudJobs(home);
  if (command === "drift") return checkCloudJobDrift(configRoot, home);
  if (command === "change") {
    confirmed(values.confirm);
    if (!values.id ||
        !["sync", "pause", "resume", "delete"].includes(values.operation ?? "")) {
      throw new CloudJobsError("INVALID_ARGUMENTS");
    }
    return changeCloudJob(
      values.id,
      values.operation as "sync" | "pause" | "resume" | "delete",
      configRoot,
      home,
      values["approval-token"],
    );
  }
  if (command === "latest") {
    if (!values.id) throw new CloudJobsError("INVALID_ARGUMENTS");
    return latestCloudJobResult(values.id, values["include-result"] ?? false, home);
  }
  throw new CloudJobsError("INVALID_ARGUMENTS");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    const code = error instanceof CloudJobsError
      ? error.code
      : error instanceof z.ZodError
        ? "INVALID_ARGUMENTS"
        : isRecord(error) && typeof error.code === "string"
          ? error.code
          : "CLOUD_JOBS_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "error", code })}\n`);
    process.exitCode = 1;
  }
}
