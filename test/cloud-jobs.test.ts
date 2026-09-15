import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerBinding } from "../src/binding-registry.js";
import {
  checkCloudJobResultNotices,
  cloudJobToolInputSchema,
  configureCloudJobs,
  extensionCloudJobInputSchema,
  exportCloudAgentProfile,
  formatCloudJobResultNotices,
  latestCloudJobResult,
  loadCloudJobsConfig,
  markCloudJobResultNotices,
  prepareCloudJob,
} from "../src/cloud-jobs.js";

test("extension cloud tool schema is a host-compatible object", () => {
  assert.equal(extensionCloudJobInputSchema.type, "object");
  assert.deepEqual(extensionCloudJobInputSchema.required, ["action"]);
  assert.equal(extensionCloudJobInputSchema.additionalProperties, false);
  assert.equal("oneOf" in extensionCloudJobInputSchema, false);
  assert.deepEqual(
    extensionCloudJobInputSchema.properties?.action,
    {
      type: "string",
      enum: [
        "configure",
        "bootstrap",
        "preview",
        "publish",
        "list",
        "drift",
        "change",
        "latest",
      ],
    },
  );
});

function enrolledProfile(body = "Research public release notes and summarize changes.\n") {
  return `---
name: synthetic-agent
description: Synthetic cloud job agent
model: auto
skills: [local-only]
tools: [view, rg, glob, bash, pinocchio_memory_search, pinocchio_memory_save, pinocchio_cloud_jobs]
mcp-servers:
  pinocchio:
    type: local
    command: node
---
${body}
<!-- pinocchio-memory:v1 -->
## Your Pinocchio agent

- Agent profile: "/tmp/synthetic.agent.md".

## Persistent memory

- Search local memory before every request.
<!-- /pinocchio-memory:v1 -->
`;
}

test("cloud export preserves authored instructions without local memory wiring", () => {
  const source = enrolledProfile();
  const result = exportCloudAgentProfile(source, ["view", "rg", "glob"]);
  assert.match(result.profile, /Research public release notes/);
  assert.match(result.profile, /tools:\s*\n\s*- view\s*\n\s*- rg\s*\n\s*- glob/);
  assert.doesNotMatch(result.profile, /pinocchio_memory|pinocchio_cloud_jobs/);
  assert.doesNotMatch(result.profile, /Persistent memory|Your Pinocchio agent/);
  assert.doesNotMatch(result.profile, /skills:|mcp-servers:|bash/);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.warnings.length, 2);
  assert.match(result.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(result.profileHash, /^[a-f0-9]{64}$/);
});

test("cloud export blocks authored local path dependencies", () => {
  const result = exportCloudAgentProfile(
    enrolledProfile("Read ~/private/source.yml before answering.\n"),
    ["view"],
  );
  assert.deepEqual(result.blockers, [
    "Local path reference must be removed or generalized: ~/private/source.yml",
  ]);
});

test("local configuration and preview keep agent history local", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-cloud-test-"));
  try {
    const home = join(root, "home");
    const configRoot = join(home, ".copilot");
    const cloudHome = join(home, ".pinocchio");
    const agents = join(configRoot, "agents");
    await mkdir(agents, { recursive: true, mode: 0o700 });
    const profile = join(agents, "synthetic-agent.agent.md");
    await writeFile(profile, enrolledProfile(), { mode: 0o600 });
    const reference = await registerBinding({
      configRoot,
      definitionPath: profile,
      origin: "user",
      originRoot: agents,
      scope: { kind: "global" },
    });
    const configured = await configureCloudJobs({
      repository: "example/pinocchio-jobs",
      cloudHome,
    });
    assert.equal(configured.credentialsStored, false);
    assert.equal((await lstat(configured.path)).mode & 0o077, 0);
    const config = await loadCloudJobsConfig(cloudHome);
    assert.equal(config.jobs.repository, "example/pinocchio-jobs");
    const parsed = cloudJobToolInputSchema.parse({
      action: "preview",
      id: "daily-release-notes",
      prompt: "Summarize public release notes.",
      cron: "30 12 * * 1-5",
      timezone: "UTC",
      tools: ["view", "rg", "glob"],
      allowUrls: [],
      maxAiCredits: 3,
      timeoutMinutes: 20,
      retentionDays: 14,
    });
    assert.equal(parsed.action, "preview");
    const preview = await prepareCloudJob(reference, parsed, cloudHome);
    assert.equal(preview.status, "approval-required");
    assert.equal(preview.sourceProfile, profile);
    assert.match(preview.exactUpload.workflow, /permissions:\n  contents: read/);
    assert.match(preview.exactUpload.workflow, /persist-credentials: false/);
    assert.match(preview.exactUpload.workflow, /copilot -C "\.pinocchio\/jobs\/daily-release-notes"/);
    assert.match(preview.exactUpload.workflow, /--secret-env-vars=COPILOT_GITHUB_TOKEN,GITHUB_TOKEN/);
    assert.match(preview.exactUpload.profile, /Research public release notes/);
    assert.doesNotMatch(preview.exactUpload.profile, /pinocchio-memory|Search local memory/);
    assert.doesNotMatch(JSON.stringify(preview.manifest), new RegExp(home));
    const draft = join(cloudHome, "drafts", `${preview.draftId}.json`);
    assert.equal((await lstat(draft)).mode & 0o077, 0);
    const saved = await readFile(draft, "utf8");
    assert.match(saved, /daily-release-notes/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("cloud result notices persist and full retrieval marks the latest run read", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-cloud-results-test-"));
  const originalPath = process.env.PATH;
  try {
    const home = join(root, "home");
    const configRoot = join(home, ".copilot");
    const cloudHome = join(home, ".pinocchio");
    const agents = join(configRoot, "agents");
    const bin = join(root, "bin");
    await mkdir(agents, { recursive: true, mode: 0o700 });
    await mkdir(bin, { mode: 0o700 });
    const profile = join(agents, "synthetic-agent.agent.md");
    await writeFile(profile, enrolledProfile(), { mode: 0o600 });
    const reference = await registerBinding({
      configRoot,
      definitionPath: profile,
      origin: "user",
      originRoot: agents,
      scope: { kind: "global" },
    });
    await configureCloudJobs({
      repository: "example/pinocchio-jobs",
      cloudHome,
    });
    const gh = join(bin, "gh");
    await writeFile(gh, `#!${process.execPath}
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    isPrivate: true,
    viewerPermission: "WRITE",
    defaultBranchRef: { name: "main" },
  }));
} else if (args[0] === "repo" && args[1] === "clone") {
  const root = args[3];
  const directory = join(root, ".pinocchio", "jobs", "daily-release-notes");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "job.yml"), ${JSON.stringify(`version: 1
id: daily-release-notes
agent: synthetic-agent
cron: "30 12 * * 1-5"
timezone: UTC
enabled: true
tools: [view]
allowed_urls: []
max_ai_credits: 1
timeout_minutes: 10
retention_days: 7
output: github-actions-summary-and-artifact
copilot_version: 1.0.83
source_hash: ${"a".repeat(64)}
profile_hash: ${"b".repeat(64)}
prompt_hash: ${"c".repeat(64)}
`)});
} else if (args[0] === "run" && args[1] === "list") {
  const limit = Number(args[args.indexOf("--limit") + 1]);
  let runs = [
    { databaseId: 12, status: "in_progress", conclusion: null,
      url: "https://example.test/runs/12", createdAt: "2026-09-15T12:00:00Z",
      updatedAt: "2026-09-15T12:01:00Z", displayTitle: "running",
      workflowName: "Pinocchio - unrelated-job" },
    { databaseId: 11, status: "completed", conclusion: "success",
      url: "https://example.test/runs/11", createdAt: "2026-09-15T11:00:00Z",
      updatedAt: "2026-09-15T11:02:00Z", displayTitle: "success",
      workflowName: "Pinocchio - daily-release-notes" },
    { databaseId: 10, status: "completed", conclusion: "failure",
      url: "https://example.test/runs/10", createdAt: "2026-09-15T10:00:00Z",
      updatedAt: "2026-09-15T10:03:00Z", displayTitle: "failure",
      workflowName: "Pinocchio - daily-release-notes" },
  ];
  if (args.includes("--workflow")) {
    runs = runs.filter((run) =>
      run.workflowName === "Pinocchio - daily-release-notes");
  }
  process.stdout.write(JSON.stringify(runs.slice(0, limit)));
} else if (args[0] === "run" && args[1] === "download") {
  const directory = args[args.indexOf("--dir") + 1];
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "result.md"), "Synthetic cloud result.\\n");
} else {
  process.stderr.write("unexpected gh arguments: " + JSON.stringify(args));
  process.exitCode = 1;
}
`);
    await chmod(gh, 0o700);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    const first = await checkCloudJobResultNotices(reference, cloudHome);
    assert.equal(first.status, "ready");
    if (first.status !== "ready") throw new Error("RESULT_NOTICE_BUSY");
    assert.deepEqual(
      first.runs.map(({ run }) => [run.databaseId, run.conclusion]),
      [[11, "success"], [10, "failure"]],
    );
    assert.match(formatCloudJobResultNotices(first), /daily-release-notes: failure/);
    assert.match(formatCloudJobResultNotices(first), /daily-release-notes: success/);
    await markCloudJobResultNotices(first, cloudHome);
    const second = await checkCloudJobResultNotices(reference, cloudHome);
    assert.equal(second.status, "ready");
    if (second.status !== "ready") throw new Error("RESULT_NOTICE_BUSY");
    assert.deepEqual(second.runs, []);

    const latest = await latestCloudJobResult(
      "daily-release-notes",
      true,
      cloudHome,
    );
    assert.equal(latest.status, "ready");
    assert.equal("result" in latest && latest.result, "Synthetic cloud result.\n");
    const statePath = join(cloudHome, "result-state.json");
    assert.equal((await lstat(statePath)).mode & 0o077, 0);
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      jobs: Record<string, {
        notifiedThrough: number;
        readThrough: number;
      }>;
    };
    assert.deepEqual(state.jobs["daily-release-notes"], {
      notifiedThrough: 11,
      readThrough: 11,
    });
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true });
  }
});
