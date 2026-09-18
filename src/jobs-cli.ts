import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { bindingForDefinition, configRootPath } from "./binding-registry.js";
import { handleJobsTool } from "./jobs.js";
import { CloudJobsError } from "./cloud-jobs.js";
import { isRecord } from "./identity.js";
import { JobsStore } from "./jobs-store.js";
import { LocalJobs } from "./local-jobs.js";

export async function main(args: string[]) {
  const { positionals, values } = parseArgs({
    args, strict: true, allowPositionals: true,
    options: {
      "config-root": { type: "string" }, "pinocchio-home": { type: "string" },
      repository: { type: "string" }, branch: { type: "string" },
      "token-secret": { type: "string" }, agent: { type: "string" },
      id: { type: "string" }, "prompt-file": { type: "string" },
      definition: { type: "string" },
      cron: { type: "string" }, backend: { type: "string" },
      timezone: { type: "string" }, "working-directory": { type: "string" },
      tool: { type: "string", multiple: true }, "allow-url": { type: "string", multiple: true },
      "max-ai-credits": { type: "string" }, "unlimited-ai-credits": { type: "boolean" },
      "timeout-minutes": { type: "string" }, "retention-days": { type: "string" },
      draft: { type: "string" }, "approval-token": { type: "string" },
      operation: { type: "string" }, "include-result": { type: "boolean" },
      "run-id": { type: "string" }, "database-id": { type: "string" },
      limit: { type: "string" },
      confirm: { type: "boolean" },
    },
  });
  if (positionals.length !== 1) throw new CloudJobsError("INVALID_ARGUMENTS");
  const command = positionals[0];
  const configRoot = configRootPath(values["config-root"]);
  const home = values["pinocchio-home"];
  const agent = values.agent ?? "current";
  const definition = values.agent
    ? `${configRoot}/agents/${values.agent}.agent.md`
    : undefined;
  const reference = definition
    ? await bindingForDefinition(configRoot, definition)
    : undefined;
  if (!reference) throw new CloudJobsError("AGENT_NOT_INSTALLED");
  const input: Record<string, unknown> = {
    action: command, backend: values.backend,
    repository: values.repository, id: values.id, cron: values.cron,
    definition: values.definition,
    timezone: values.timezone,
    workingDirectory: values["working-directory"] ?? process.cwd(),
    draftId: values.draft, approvalToken: values["approval-token"],
    operation: values.operation, includeResult: values["include-result"],
    runId: values["run-id"],
    databaseId: values["database-id"] ? Number(values["database-id"]) : undefined,
    limit: values.limit ? Number(values.limit) : undefined,
    confirmed: values.confirm, tools: values.tool, allowUrls: values["allow-url"],
    unlimitedAiCredits: values["unlimited-ai-credits"],
    maxAiCredits: values["max-ai-credits"] ? Number(values["max-ai-credits"]) : undefined,
    timeoutMinutes: values["timeout-minutes"] ? Number(values["timeout-minutes"]) : undefined,
    retentionDays: values["retention-days"] ? Number(values["retention-days"]) : undefined,
  };
  if (command === "preview") {
    const { readFile } = await import("node:fs/promises");
    if (values.definition) {
      if (values["prompt-file"] || values.cron) {
        throw new CloudJobsError("INVALID_ARGUMENTS");
      }
    } else {
      if (!values["prompt-file"]) throw new CloudJobsError("INVALID_ARGUMENTS");
      input.prompt = await readFile(values["prompt-file"], "utf8");
    }
  }
  void agent;
  const store = await JobsStore.open(configRoot);
  const localJobs = new LocalJobs(store);
  try {
    return await handleJobsTool(reference, input, home, localJobs);
  } finally {
    await localJobs.close();
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    const code = error instanceof CloudJobsError
      ? error.code
      : error instanceof z.ZodError
        ? "INVALID_ARGUMENTS"
        : isRecord(error) && typeof error.code === "string" ? error.code : "JOBS_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "error", code })}\n`);
    process.exitCode = 1;
  }
}
