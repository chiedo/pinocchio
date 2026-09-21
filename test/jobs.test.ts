import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CopilotSession } from "@github/copilot-sdk";
import { registerBinding } from "../src/binding-registry.js";
import { JOBS_TOOL, jobsToolInputSchema } from "../src/jobs.js";
import {
  githubJobSourceSchema,
  parseGitHubJobLocator,
  repositoryJobSchema,
  sourcePolicyAllows,
} from "../src/local-job-sources.js";
import type {
  GitHubJobSource,
  ResolvedRepositoryJob,
} from "../src/local-job-sources.js";
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
  const sourced = jobsToolInputSchema.parse({
    action: "preview",
    backend: "local",
    definition: "github://github/example-jobs/.pinocchio/jobs/feedback.yml?ref=main",
    workingDirectory: "/tmp",
  });
  assert.equal(sourced.definition?.includes("github/example-jobs"), true);
});

test("repository-backed local job locators and policies are constrained", () => {
  assert.deepEqual(repositoryJobSchema.parse({
    version: 1,
    id: "feedback",
    prompt: "Summarize feedback.",
  }), {
    version: 1,
    id: "feedback",
    execution: {
      "working-directory": "subscriber",
      "required-tools": [],
      "timeout-minutes": 30,
    },
    prompt: "Summarize feedback.",
  });
  assert.deepEqual(
    parseGitHubJobLocator(
      "github://github/example-jobs/.pinocchio/jobs/feedback.yml?ref=main",
    ),
    {
      locator: "github://github/example-jobs/.pinocchio/jobs/feedback.yml?ref=main",
      repository: "github/example-jobs",
      ref: "main",
      path: ".pinocchio/jobs/feedback.yml",
    },
  );
  assert.throws(() =>
    parseGitHubJobLocator(
      "github://github/example-jobs/../private.yml?ref=main",
    ));
  const source: GitHubJobSource = {
    kind: "github",
    locator: "github://github/example-jobs/job.yml?ref=main",
    repository: "github/example-jobs",
    ref: "main",
    path: "job.yml",
    resolvedCommit: "a".repeat(40),
    definitionFingerprint: "b".repeat(64),
    lastSyncedAt: "2026-09-18T12:00:00.000Z",
    checkoutDirectory: "/tmp/source",
    workingDirectoryMode: "subscriber",
    automaticExecutionAllowed: true,
    allowedTools: ["view"],
    maximumTimeoutMinutes: 30,
    maximumAiCredits: 50,
  };
  const resolved: ResolvedRepositoryJob = {
    id: "feedback",
    prompt: "Summarize feedback.",
    cron: "0 10 * * 1-5",
    timezone: "UTC",
    requiredTools: ["view"],
    timeoutMinutes: 20,
    maxAiCredits: 40,
    workingDirectoryMode: "subscriber",
    sourceDirectory: "/tmp/source",
    source: {
      kind: "github",
      locator: source.locator,
      repository: source.repository,
      ref: source.ref,
      path: source.path,
      resolvedCommit: source.resolvedCommit,
      definitionFingerprint: source.definitionFingerprint,
      lastSyncedAt: source.lastSyncedAt,
      checkoutDirectory: source.checkoutDirectory,
    },
  };
  assert.equal(sourcePolicyAllows(source, resolved), true);
  assert.equal(sourcePolicyAllows(source, {
    ...resolved,
    requiredTools: ["view", "slack-slack_search_public"],
  }), false);
  const { maxAiCredits: _maxAiCredits, ...withoutAiLimit } = resolved;
  assert.equal(sourcePolicyAllows(source, {
    ...withoutAiLimit,
  }), false);
  assert.equal(sourcePolicyAllows({
    ...source,
    automaticExecutionAllowed: false,
  }, resolved), false);
  const { cron: _cron, ...manualResolved } = resolved;
  assert.equal(sourcePolicyAllows({
    ...source,
    automaticExecutionAllowed: false,
  }, manualResolved), true);
  const {
    automaticExecutionAllowed: _automaticExecutionAllowed,
    ...legacySource
  } = source;
  assert.equal(
    githubJobSourceSchema.parse(legacySource).automaticExecutionAllowed,
    true,
  );
});

test("job storage records repository source revisions on runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-source-store-"));
  try {
    const store = await JobsStore.open(join(root, ".copilot"));
    try {
      const source: GitHubJobSource = {
        kind: "github",
        locator: "github://github/example-jobs/job.yml?ref=main",
        repository: "github/example-jobs",
        ref: "main",
        path: "job.yml",
        resolvedCommit: "a".repeat(40),
        definitionFingerprint: "b".repeat(64),
        lastSyncedAt: "2026-09-18T12:00:00.000Z",
        checkoutDirectory: "/tmp/source",
        workingDirectoryMode: "subscriber",
        automaticExecutionAllowed: false,
        allowedTools: ["view"],
        maximumTimeoutMinutes: 30,
      };
      const job = store.putJob({
        uid: "source-job",
        ownerBindingId: "owner",
        ownerFingerprint: "fingerprint",
        ownerAgent: "agent",
        ownerScope: "global",
        slug: "source-job",
        backend: "local",
        revision: 1,
        prompt: "Run the job.",
        cron: "",
        timezone: "UTC",
        workingDirectory: "/tmp",
        requiredTools: ["view"],
        timeoutMinutes: 30,
        source,
        state: "enabled",
        approvalFingerprint: "approval",
        createdAt: "2026-09-18T12:00:00.000Z",
        updatedAt: "2026-09-18T12:00:00.000Z",
      });
      assert.equal(job?.source?.resolvedCommit, source.resolvedCommit);
      assert.equal(store.dueJobs("owner", "9999-12-31T23:59:59.999Z").length, 0);
      const run = store.claimRun(job!, "manual:source", "session");
      assert.equal(run?.sourceCommit, source.resolvedCommit);
      assert.equal(
        run?.definitionFingerprint,
        source.definitionFingerprint,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
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
    let sourceCalls = 0;
    let sourceShouldFail = false;
    const resolveSource = async (locator: string): Promise<ResolvedRepositoryJob> => {
      sourceCalls++;
      if (sourceShouldFail) {
        throw Object.assign(new Error("JOB_SOURCE_SYNC_FAILED"), {
          code: "JOB_SOURCE_SYNC_FAILED",
        });
      }
      const revision = sourceCalls.toString(16).padStart(40, "0");
      return {
        id: "interactive-feedback",
        prompt: "Collect feedback after interactive login.",
        timezone: "UTC",
        requiredTools: ["view"],
        timeoutMinutes: 10,
        workingDirectoryMode: "subscriber",
        sourceDirectory: join(root, "source"),
        source: {
          kind: "github",
          locator,
          repository: "github/example-jobs",
          ref: "main",
          path: ".pinocchio/jobs/interactive-feedback.yml",
          resolvedCommit: revision,
          definitionFingerprint: revision.padStart(64, "0"),
          lastSyncedAt: new Date().toISOString(),
          checkoutDirectory: join(root, "source", revision),
        },
      };
    };
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
    const local = new LocalJobs(store, fakeSession, resolveSource);
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

      const manualPreview = await local.preview(reference, {
        definition:
          "github://github/example-jobs/.pinocchio/jobs/interactive-feedback.yml?ref=main",
        workingDirectory: work,
      });
      assert.equal(manualPreview.exactJob.schedule, undefined);
      assert.equal(manualPreview.exactJob.nextDueAt, undefined);
      const manualPublished = await local.publish(
        reference,
        manualPreview.draftId,
        manualPreview.approvalToken,
      );
      assert.equal(manualPublished.status, "published");
      const manualInspection = local.inspect(reference, "interactive-feedback");
      assert.equal(manualInspection.schedule, null);
      assert.equal(manualInspection.nextDueAt, undefined);
      assert.equal(store.dueJobs(
        reference.bindingId,
        "9999-12-31T23:59:59.999Z",
      ).some((job) => job.slug === "interactive-feedback"), false);

      sourceShouldFail = true;
      await assert.rejects(
        local.run(reference, "interactive-feedback"),
        /JOB_SOURCE_SYNC_FAILED/,
      );
      assert.equal(local.history(reference, "interactive-feedback").length, 0);

      sourceShouldFail = false;
      taskStatus = "running";
      const manualStarted = await local.run(reference, "interactive-feedback");
      assert.equal(manualStarted?.status, "running");
      assert.equal(manualStarted?.sourceCommit, sourceCalls.toString(16).padStart(40, "0"));
      assert.equal(
        manualStarted?.definitionFingerprint,
        sourceCalls.toString(16).padStart(64, "0"),
      );
    } finally {
      await local.close();
      store.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});
