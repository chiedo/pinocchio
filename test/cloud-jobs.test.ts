import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerBinding } from "../src/binding-registry.js";
import {
  cloudJobToolInputSchema,
  configureCloudJobs,
  extensionCloudJobInputSchema,
  exportCloudAgentProfile,
  loadCloudJobsConfig,
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
