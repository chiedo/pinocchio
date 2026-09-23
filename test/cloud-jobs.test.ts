import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "yaml";
import { registerBinding } from "../src/binding-registry.js";
import {
  checkCloudJobResultNotices,
  checkOwnerCloudJobDrift,
  cancelCloudJobRun,
  cloudJobToolInputSchema,
  configureCloudJobs,
  configureOwnerCloudJobs,
  discoverCloudJobs,
  extensionCloudJobInputSchema,
  exportCloudAgentProfile,
  formatCloudJobResultNotices,
  inspectCloudJob,
  latestCloudJobResult,
  listCloudJobHistory,
  loadCloudJobsConfig,
  markCloudJobResultNotices,
  prepareCloudJob,
  registerCloudJobRepository,
  releaseCloudJobResultNotices,
  resolveCloudJobOwner,
  runCloudJobNow,
  serializeCloudJobManifest,
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
  const defaultPreview = cloudJobToolInputSchema.parse({
    action: "preview",
    id: "default-limit",
    prompt: "Summarize.",
    cron: "0 * * * *",
  });
  assert.equal(defaultPreview.action, "preview");
  if (defaultPreview.action !== "preview") throw new Error("INVALID_PREVIEW");
  assert.equal(defaultPreview.maxAiCredits, 30);
  assert.equal(defaultPreview.unlimitedAiCredits, false);
  assert.deepEqual(defaultPreview.tools, ["*"]);
  assert.throws(() => cloudJobToolInputSchema.parse({
    ...defaultPreview,
    tools: ["*", "view"],
  }));
  assert.throws(() => cloudJobToolInputSchema.parse({
    ...defaultPreview,
    maxAiCredits: 29,
  }));
});

function enrolledProfile(body = "Research public release notes and summarize changes.\n") {
  return `---
name: synthetic-agent
description: Synthetic cloud job agent
model: auto
skills: [local-only]
tools: [view, rg, glob, bash, pinocchio_memory_search, pinocchio_memory_save, pinocchio_jobs]
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

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

test("cloud export preserves authored instructions without local memory wiring", () => {
  const source = enrolledProfile();
  const result = exportCloudAgentProfile(source, ["view", "rg", "glob"]);
  assert.match(result.profile, /Research public release notes/);
  const frontmatter = parse(result.profile.split("---")[1] ?? "") as {
    tools?: unknown;
  };
  assert.deepEqual(frontmatter.tools, ["view", "rg", "glob"]);
  assert.doesNotMatch(result.profile, /pinocchio_memory|pinocchio_jobs/);
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

test("permissive cloud export enables all tools without exporting local integrations", () => {
  const result = exportCloudAgentProfile(enrolledProfile(), ["*"]);
  const frontmatter = parse(result.profile.split("---")[1] ?? "") as { tools: string[] };
  assert.deepEqual(frontmatter.tools, ["*"]);
  assert.match(result.profile, /require\('playwright'\)/);
  assert.match(result.profile, /PINOCCHIO_OUTPUT_DIR/);
  assert.doesNotMatch(result.profile, /pinocchio_memory|pinocchio_jobs|mcp-servers:|skills:/);
  assert.match(result.warnings.join("\n"), /Unrestricted cloud execution/);
  assert.throws(
    () => exportCloudAgentProfile(enrolledProfile(), ["web_fetch"]),
    /CLOUD_PROFILE_TOOL_NOT_CONFIGURED/,
  );
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
      tokenSecret: "GITHUB_TOKEN",
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
      maxAiCredits: 30,
      unlimitedAiCredits: true,
      timeoutMinutes: 20,
      retentionDays: 14,
    });
    assert.equal(parsed.action, "preview");
    const preview = await prepareCloudJob(reference, parsed, cloudHome);
    const remoteId = preview.manifest.remote_id;
    assert.ok(remoteId);
    assert.equal(preview.status, "approval-required");
    assert.equal(preview.sourceProfile, profile);
    assert.match(
      preview.exactUpload.workflow,
      /permissions:\n  contents: read\n  copilot-requests: write/,
    );
    assert.match(preview.exactUpload.workflow, /persist-credentials: false/);
    assert.match(preview.exactUpload.workflow, new RegExp(
      `copilot -C "\\.pinocchio/jobs/${remoteId}"`,
    ));
    assert.match(preview.exactUpload.workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.doesNotMatch(preview.exactUpload.workflow, /COPILOT_GITHUB_TOKEN: \$\{\{/);
    assert.match(preview.exactUpload.workflow, /--secret-env-vars=COPILOT_GITHUB_TOKEN,GITHUB_TOKEN/);
    assert.match(preview.exactUpload.workflow, /set -o pipefail/);
    assert.match(preview.exactUpload.workflow, /2>&1 \| tee result\.md/);
    assert.doesNotMatch(preview.exactUpload.workflow, /--max-ai-credits/);
    assert.equal(preview.manifest.max_ai_credits, null);
    assert.match(
      serializeCloudJobManifest(preview.manifest),
      /^# Non-Pinocchio agents:/,
    );
    assert.match(
      preview.exactUpload.manifest,
      /docs\/NON-PINOCCHIO-JOBS\.md/,
    );
    assert.match(preview.exactUpload.profile, /Research public release notes/);
    assert.doesNotMatch(preview.exactUpload.profile, /pinocchio-memory|Search local memory/);
    assert.doesNotMatch(JSON.stringify(preview.manifest), new RegExp(home));
    const draft = join(cloudHome, "drafts", `${preview.draftId}.json`);
    assert.equal((await lstat(draft)).mode & 0o077, 0);
    const saved = await readFile(draft, "utf8");
    assert.match(saved, /daily-release-notes/);
    assert.match(preview.exactUpload.workflow, /--available-tools 'view' 'rg' 'glob'/);
    assert.doesNotMatch(preview.exactUpload.workflow, /Install Playwright|Store screenshots|--allow-all \\/);

    const permissive = await prepareCloudJob(reference, { ...parsed, tools: ["*"] }, cloudHome);
    assert.deepEqual(permissive.manifest.tools, ["*"]);
    assert.match(permissive.exactUpload.workflow, /--allow-all \\/);
    assert.doesNotMatch(permissive.exactUpload.workflow, /--available-tools|--allow-url=/);
    assert.match(permissive.exactUpload.workflow, /playwright@1\.63\.0/);
    assert.match(permissive.exactUpload.workflow, /install --with-deps chromium firefox webkit/);
    assert.match(permissive.exactUpload.workflow, /NODE_PATH=/);
    assert.match(permissive.exactUpload.workflow, /PINOCCHIO_OUTPUT_DIR=/);
    const workflow = parse(permissive.exactUpload.workflow) as {
      jobs: { run: { steps: { name: string; run?: string; if?: string; with?: { name?: string; path?: string } }[] } };
    };
    const steps = workflow.jobs.run.steps;
    const artifact = steps.find((step) => step.name === "Store screenshots and deliverables");
    assert.equal(artifact?.if, "always()");
    assert.equal(artifact?.with?.name, `pinocchio-${remoteId}-output`);
    assert.equal(artifact?.with?.path, `.pinocchio/jobs/${remoteId}/output/`);
    assert.equal(
      steps.find((step) => step.name === "Store result")?.with?.path,
      "result.md",
    );
    await assert.rejects(
      prepareCloudJob(reference, { ...parsed, tools: ["*"], allowUrls: ["https://example.com"] }, cloudHome),
      /CLOUD_UNRESTRICTED_URL_ALLOWLIST_CONFLICT/,
    );

    // Exercise the generated Linux setup in CI, never install browsers on a developer's machine.
    if (process.env.GITHUB_ACTIONS === "true") {
      const setup = steps.find((step) => step.name === "Install Playwright and browsers")?.run;
      assert.ok(setup);
      const execute = promisify(execFile);
      const environmentFile = join(root, "browser-env");
      const pathFile = join(root, "browser-path");
      await execute("bash", ["-e", "-o", "pipefail", "-c", setup], {
        cwd: root,
        env: { ...process.env, RUNNER_TEMP: root, GITHUB_WORKSPACE: root, GITHUB_ENV: environmentFile, GITHUB_PATH: pathFile },
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const browserEnv = Object.fromEntries(
        (await readFile(environmentFile, "utf8")).trim().split("\n").map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
      );
      await execute(process.execPath, ["-e", `
        const { chromium, firefox, webkit } = require('playwright');
        const { join } = require('node:path');
        (async () => {
          for (const browserType of [chromium, firefox, webkit]) {
            const browser = await browserType.launch();
            try {
              const page = await browser.newPage();
              await page.setContent('<h1>Cloud browser screenshot</h1>');
              await page.screenshot({ path: join(process.env.PINOCCHIO_OUTPUT_DIR, browserType.name() + '.png') });
            } finally {
              await browser.close();
            }
          }
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `], {
        cwd: root,
        env: { ...process.env, ...browserEnv },
        timeout: 120_000,
      });
      for (const browser of ["chromium", "firefox", "webkit"]) {
        const screenshot: Buffer = await readFile(
          join(root, `.pinocchio/jobs/${remoteId}/output`, `${browser}.png`),
        );
        assert.deepEqual([...screenshot.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.ok(screenshot.length > 100);
      }
    }
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
repository: example/pinocchio-jobs
cron: "30 12 * * 1-5"
timezone: UTC
enabled: true
tools: [view]
allowed_urls: []
max_ai_credits: 30
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
    assert.equal(first.runs[0]?.content, "Synthetic cloud result.\n");
    assert.equal("content" in (first.runs[1] ?? {}), false);
    assert.match(
      formatCloudJobResultNotices(first),
      /daily-release-notes \[example\/pinocchio-jobs\]: failure/,
    );
    assert.match(
      formatCloudJobResultNotices(first),
      /daily-release-notes \[example\/pinocchio-jobs\]: success/,
    );
    assert.match(formatCloudJobResultNotices(first), /Synthetic cloud result/);
    assert.match(formatCloudJobResultNotices(first), /Do not ask whether to retrieve/);
    assert.match(formatCloudJobResultNotices(first), /do not save notices or cloud results to memory automatically/i);
    const second = await checkCloudJobResultNotices(reference, cloudHome);
    assert.equal(second.status, "ready");
    if (second.status !== "ready") throw new Error("RESULT_NOTICE_BUSY");
    assert.deepEqual(second.runs, []);
    await releaseCloudJobResultNotices(first, cloudHome);
    const retried = await checkCloudJobResultNotices(reference, cloudHome);
    assert.equal(retried.status, "ready");
    if (retried.status !== "ready") throw new Error("RESULT_NOTICE_BUSY");
    assert.deepEqual(
      retried.runs.map(({ run }) => run.databaseId),
      [11, 10],
    );
    await markCloudJobResultNotices(retried, cloudHome);
    const deliveredState = JSON.parse(
      await readFile(
        join(cloudHome, `result-state-${digest("example/pinocchio-jobs")}.json`),
        "utf8",
      ),
    ) as {
      jobs: Record<string, {
        notifiedThrough: number;
        readThrough: number;
      }>;
    };
    assert.deepEqual(deliveredState.jobs["daily-release-notes"], {
      notifiedThrough: 11,
      readThrough: 11,
    });
    const marked = await checkCloudJobResultNotices(reference, cloudHome);
    assert.equal(marked.status, "ready");
    if (marked.status !== "ready") throw new Error("RESULT_NOTICE_BUSY");
    assert.deepEqual(marked.runs, []);

    const latest = await latestCloudJobResult(
      "daily-release-notes",
      true,
      cloudHome,
    );
    assert.equal(latest.status, "ready");
    assert.equal("result" in latest && latest.result, "Synthetic cloud result.\n");
    const statePath = join(
      cloudHome,
      `result-state-${digest("example/pinocchio-jobs")}.json`,
    );
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

test("registered owner repositories aggregate and route management per destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-cloud-catalog-test-"));
  const originalPath = process.env.PATH;
  try {
    const home = join(root, "home");
    const configRoot = join(home, ".copilot");
    const cloudHome = join(home, ".pinocchio");
    const agents = join(configRoot, "agents");
    const bin = join(root, "bin");
    const log = join(root, "gh.log");
    const failRepositoryB = join(root, "fail-repository-b");
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
    const owner = await resolveCloudJobOwner(reference);
    const repositoryA = "example/jobs-a";
    const repositoryB = "example/jobs-b";
    const remoteA = "summary--aaaaaaaaaaaaaaaa";
    const remoteB = "summary--bbbbbbbbbbbbbbbb";
    const manifest = (repository: string, remoteId: string, uid: string) => `version: 1
id: summary
agent: synthetic-agent
repository: ${repository}
uid: "${uid}"
owner: ${owner.id}
owner_label: synthetic-agent
remote_id: ${remoteId}
cron: "0 12 * * *"
timezone: UTC
enabled: true
tools: [view]
allowed_urls: []
max_ai_credits: 30
timeout_minutes: 10
retention_days: 7
output: github-actions-summary-and-artifact
copilot_version: 1.0.83
source_hash: ${"a".repeat(64)}
profile_hash: ${"b".repeat(64)}
prompt_hash: ${"c".repeat(64)}
`;
    const gh = join(bin, "gh");
    await writeFile(gh, `#!${process.execPath}
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const repositoryFlag = args.indexOf("--repo");
const repository = repositoryFlag >= 0 ? args[repositoryFlag + 1] : args[2];
const remote = repository === ${JSON.stringify(repositoryA)}
  ? ${JSON.stringify(remoteA)}
  : ${JSON.stringify(remoteB)};
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    isPrivate: true,
    viewerPermission: "WRITE",
    defaultBranchRef: { name: "main" },
  }));
} else if (args[0] === "repo" && args[1] === "clone") {
  if (args[2] === ${JSON.stringify(repositoryB)} &&
      existsSync(${JSON.stringify(failRepositoryB)})) {
    process.exit(1);
  }
  const destination = args[3];
  const selectedRemote = args[2] === ${JSON.stringify(repositoryA)}
    ? ${JSON.stringify(remoteA)}
    : ${JSON.stringify(remoteB)};
  const directory = join(destination, ".pinocchio", "jobs", selectedRemote);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "job.yml"),
    args[2] === ${JSON.stringify(repositoryA)}
      ? ${JSON.stringify(manifest(repositoryA, remoteA, "1".repeat(64)))}
      : ${JSON.stringify(manifest(repositoryB, remoteB, "2".repeat(64)))},
  );
} else if (args[0] === "run" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{
    databaseId: repository === ${JSON.stringify(repositoryA)} ? 101 : 202,
    status: "completed",
    conclusion: "success",
    url: "https://example.test/runs/" +
      (repository === ${JSON.stringify(repositoryA)} ? "101" : "202"),
    createdAt: "2026-09-16T12:00:00Z",
    updatedAt: "2026-09-16T12:02:00Z",
    displayTitle: "summary",
    workflowName: "Pinocchio - " + remote,
  }]));
} else if (args[0] === "run" && args[1] === "download") {
  const directory = args[args.indexOf("--dir") + 1];
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "result.md"),
    "Result from " + repository + ".\\n",
  );
} else if (args[0] === "workflow" && args[1] === "run") {
  process.exit(0);
} else if (args[0] === "run" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    databaseId: Number(args[2]),
    status: "in_progress",
    conclusion: null,
    url: "https://example.test/runs/" + args[2],
    createdAt: "2026-09-16T12:00:00Z",
    updatedAt: "2026-09-16T12:01:00Z",
    displayTitle: "summary",
    workflowName: "Pinocchio - " + remote,
  }));
} else if (args[0] === "run" && args[1] === "cancel") {
  process.exit(0);
} else {
  process.stderr.write("unexpected gh arguments: " + JSON.stringify(args));
  process.exit(1);
}
`);
    await chmod(gh, 0o700);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    await configureOwnerCloudJobs(
      reference,
      { repository: repositoryA },
      cloudHome,
    );
    await registerCloudJobRepository(
      reference,
      { repository: repositoryB },
      cloudHome,
    );
    const catalogText = await readFile(
      join(cloudHome, "cloud-repositories.json"),
      "utf8",
    );
    const catalog = JSON.parse(catalogText) as {
      owners: Record<string, {
        repositories: Record<string, unknown>;
      }>;
    };
    assert.deepEqual(
      Object.keys(catalog.owners[owner.id]?.repositories ?? {}).sort(),
      [repositoryA, repositoryB],
    );
    assert.equal(
      (catalog.owners[owner.id] as { defaultRepository?: string } | undefined)
        ?.defaultRepository,
      repositoryA,
    );
    assert.doesNotMatch(catalogText, new RegExp(configRoot));
    assert.doesNotMatch(catalogText, new RegExp(reference.bindingId));
    assert.doesNotMatch(catalogText, new RegExp(reference.fingerprint));
    const defaultPreviewInput = cloudJobToolInputSchema.parse({
      action: "preview",
      id: "uses-owner-default",
      prompt: "Use the registered owner default.",
      cron: "0 9 * * *",
      tools: ["view"],
    });
    assert.equal(defaultPreviewInput.action, "preview");
    if (defaultPreviewInput.action !== "preview") {
      throw new Error("INVALID_PREVIEW");
    }
    const defaultPreview = await prepareCloudJob(
      reference,
      defaultPreviewInput,
      cloudHome,
    );
    assert.equal(defaultPreview.repository, repositoryA);

    const discovered = await discoverCloudJobs(reference, cloudHome);
    assert.equal(discovered.status, "ready", JSON.stringify(discovered));
    assert.deepEqual(
      discovered.jobs.map((job) => [job.repository, job.id, job.remoteId]),
      [
        [repositoryA, "summary", remoteA],
        [repositoryB, "summary", remoteB],
      ],
    );
    await assert.rejects(
      inspectCloudJob(reference, "summary", cloudHome),
      /CLOUD_JOB_AMBIGUOUS/,
    );
    const inspected = await inspectCloudJob(
      reference,
      "summary",
      cloudHome,
      repositoryB,
    );
    assert.equal(inspected.job.remoteId, remoteB);

    const history = await listCloudJobHistory(
      reference,
      "summary",
      { repository: repositoryB, limit: 5 },
      cloudHome,
    );
    assert.equal(history.repository, repositoryB);
    assert.equal(history.history[0]?.run.databaseId, 202);
    const drift = await checkOwnerCloudJobDrift(
      reference,
      0,
      cloudHome,
    );
    assert.equal(drift.status, "checked");
    assert.deepEqual(
      drift.sources.map((source) => source.repository).sort(),
      [repositoryA, repositoryB],
    );
    for (const repository of [repositoryA, repositoryB]) {
      assert.equal(
        (await lstat(
          join(cloudHome, `drift-state-${digest(repository)}.json`),
        )).mode & 0o077,
        0,
      );
    }
    const requested = await runCloudJobNow(
      reference,
      "summary",
      { repository: repositoryA },
      cloudHome,
    );
    assert.equal(requested.status, "requested");
    assert.equal(requested.remoteId, remoteA);
    const cancelled = await cancelCloudJobRun(
      reference,
      "summary",
      202,
      { repository: repositoryB },
      cloudHome,
    );
    assert.equal(cancelled.status, "cancellation-requested");
    assert.equal(cancelled.remoteId, remoteB);

    const notices = await checkCloudJobResultNotices(reference, cloudHome);
    assert.equal(notices.status, "ready", JSON.stringify(notices));
    if (notices.status !== "ready") throw new Error("RESULT_NOTICE_BUSY");
    assert.deepEqual(
      notices.runs.map((item) => [item.repository, item.remoteId]).sort(),
      [[repositoryA, remoteA], [repositoryB, remoteB]],
    );
    await releaseCloudJobResultNotices(notices, cloudHome);
    const retried = await checkCloudJobResultNotices(reference, cloudHome);
    assert.equal(retried.status, "ready");
    if (retried.status !== "ready") throw new Error("RESULT_NOTICE_BUSY");
    assert.equal(retried.runs.length, 2);
    await markCloudJobResultNotices(retried, cloudHome);
    const acknowledged = await checkCloudJobResultNotices(
      reference,
      cloudHome,
    );
    assert.equal(acknowledged.status, "ready");
    if (acknowledged.status !== "ready") {
      throw new Error("RESULT_NOTICE_BUSY");
    }
    assert.deepEqual(acknowledged.runs, []);
    const resultStates: [string, string][] = [
      [repositoryA, remoteA],
      [repositoryB, remoteB],
    ];
    for (const [repository, remoteId] of resultStates) {
      const state = JSON.parse(await readFile(
        join(cloudHome, `result-state-${digest(repository)}.json`),
        "utf8",
      )) as {
        repository: string;
        jobs: Record<string, { notifiedThrough: number }>;
      };
      assert.equal(state.repository, repository);
      assert.ok(state.jobs[remoteId]?.notifiedThrough);
    }

    await writeFile(failRepositoryB, "fail\n");
    const partial = await discoverCloudJobs(reference, cloudHome);
    assert.equal(partial.status, "partial");
    assert.deepEqual(
      partial.jobs.map((job) => job.repository),
      [repositoryA],
    );
    const failedSource = partial.sources.find(
      (source) => source.repository === repositoryB,
    );
    assert.equal(failedSource?.status, "unavailable");
    assert.equal(
      failedSource?.status === "unavailable"
        ? failedSource.code
        : undefined,
      "CLOUD_REPOSITORY_CLONE_FAILED",
    );
    assert.ok(
      failedSource?.status === "unavailable" &&
      failedSource.successfulAt,
    );

    const calls = (await readFile(log, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((args) =>
      args[0] === "workflow" &&
      args[1] === "run" &&
      args.includes(`pinocchio-${remoteA}.yml`) &&
      args.includes(repositoryA)));
    assert.ok(calls.some((args) =>
      args[0] === "run" &&
      args[1] === "cancel" &&
      args.includes("202") &&
      args.includes(repositoryB)));
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true });
  }
});
