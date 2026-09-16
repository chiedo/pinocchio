import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CopilotSession } from "@github/copilot-sdk";
import { registerBinding } from "../src/binding-registry.js";
import { JOBS_TOOL, jobsToolInputSchema } from "../src/jobs.js";
import { LocalJobs, nextCronOccurrence } from "../src/local-jobs.js";
import { JobsStore } from "../src/jobs-store.js";

test("unified jobs input exposes local and cloud jobs", () => {
  assert.equal(JOBS_TOOL, "pinocchio_jobs");
  const preview = jobsToolInputSchema.parse({
    action: "preview",
    backend: "cloud",
    repository: "example/research-jobs",
    id: "release-summary",
    prompt: "Summarize approved sources.",
    cron: "15 10 * * 1-5",
  });
  assert.equal(preview.backend, "cloud");
  assert.equal(preview.repository, "example/research-jobs");
  const local = jobsToolInputSchema.parse({
    action: "preview",
    backend: "local",
    id: "feedback-summary",
    prompt: "Summarize feedback.",
    cron: "0 10 * * 1-5",
    timezone: "America/New_York",
    workingDirectory: "/tmp",
  });
  assert.equal(local.backend, "local");
  assert.equal(
    nextCronOccurrence(
      "0 10 * * 1-5",
      "America/New_York",
      new Date("2026-09-16T13:00:00Z"),
    ).toISOString(),
    "2026-09-16T14:00:00.000Z",
  );
});

test("local jobs preview, publish and run through the native task API", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-local-jobs-"));
  try {
    const configRoot = join(root, ".copilot");
    const agents = join(configRoot, "agents");
    const work = join(root, "work");
    await mkdir(agents, { recursive: true, mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    const profile = join(agents, "local-agent.agent.md");
    await writeFile(profile, [
      "---",
      "name: local-agent",
      "description: Local job test",
      "tools: [view, pinocchio_memory_search, pinocchio_memory_save, pinocchio_jobs]",
      "---",
      "Complete local jobs.",
      "",
    ].join("\n"), { mode: 0o600 });
    const reference = await registerBinding({
      configRoot,
      definitionPath: profile,
      origin: "user",
      originRoot: agents,
      scope: { kind: "global" },
    });
    let taskStatus: "running" | "completed" = "running";
    const fakeSession = {
      sessionId: "local-session",
      rpc: {
        tools: {
          getCurrentMetadata: async () => ({
            tools: [{ name: "view" }],
          }),
        },
        tasks: {
          startAgent: async () => ({ agentId: "native-task-1" }),
          list: async () => ({
            tasks: [{
              type: "agent",
              id: "native-task-1",
              toolCallId: "tool-1",
              description: "Local job test",
              status: taskStatus,
              startedAt: "2026-09-16T14:00:00Z",
              agentType: "local-agent",
              prompt: "test",
              result: taskStatus === "completed" ? "Completed local work." : undefined,
            }],
          }),
          cancel: async () => ({ cancelled: true }),
        },
      },
    } as unknown as CopilotSession;
    const store = await JobsStore.open(configRoot);
    const local = new LocalJobs(store, fakeSession);
    try {
      local.setActiveOwner(reference, "local-agent", work);
      const preview = await local.preview(reference, {
        id: "daily-summary",
        prompt: "Summarize approved inputs.",
        cron: "0 10 * * 1-5",
        timezone: "America/New_York",
        workingDirectory: work,
        requiredTools: ["view"],
        timeoutMinutes: 10,
      });
      const published = await local.publish(
        reference,
        preview.draftId,
        preview.approvalToken,
      );
      assert.equal(published.status, "published");
      const started = await local.run(reference, "daily-summary");
      assert.equal(started?.status, "running");
      assert.equal(started?.runtimeTaskId, "native-task-1");
      taskStatus = "completed";
      await local.reconcile("native-task-1");
      const latest = local.latest(reference, "daily-summary", true);
      assert.equal(latest.status, "ready");
      if (latest.status !== "ready") throw new Error("LOCAL_RESULT_MISSING");
      assert.equal(latest.outcome, "succeeded");
      assert.equal(latest.result, "Completed local work.");
    } finally {
      await local.close();
      store.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});
