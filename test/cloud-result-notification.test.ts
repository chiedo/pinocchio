import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  approveAll,
  CopilotClient,
  RuntimeConnection,
  ToolSet,
} from "@github/copilot-sdk";
import { registerBinding } from "../src/binding-registry.js";
import { configureCloudJobs } from "../src/cloud-jobs.js";
import { enroll } from "../src/enrollment.js";
import { EXTENSION_SEARCH_TOOL } from "../src/memory-protocol.js";
import { startSyntheticProvider } from "./support/provider.js";
import { createWorkspace } from "./support/workspace.js";

test("an open agent session announces unread cloud results without a user prompt", {
  timeout: 120_000,
}, async () => {
  const workspace = await createWorkspace();
  const provider = await startSyntheticProvider({ textOnly: true });
  const config = await realpath(workspace.config);
  const repository = await realpath(workspace.repository);
  const home = dirname(config);
  const cloudHome = join(home, ".pinocchio");
  const agents = join(config, "agents");
  const bin = resolve(config, "..", "..", "bin");
  await rm(join(repository, ".github", "extensions", "pinocchio"), {
    recursive: true,
  });
  await mkdir(agents, { recursive: true, mode: 0o700 });
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const profile = join(agents, "notice-agent.agent.md");
  await writeFile(profile, [
    "---",
    "name: notice-agent",
    "description: Synthetic notice agent",
    "tools: [view]",
    "---",
    "Reply briefly.",
    "",
  ].join("\n"), { mode: 0o600 });
  const reference = await registerBinding({
    configRoot: config,
    definitionPath: profile,
    origin: "user",
    originRoot: agents,
    scope: { kind: "global" },
  });
  await enroll(reference);
  await configureCloudJobs({
    repository: "example/pinocchio-jobs",
    cloudHome,
  });
  const manifest = `version: 1
id: changelog
agent: notice-agent
cron: "*/15 * * * *"
timezone: UTC
enabled: true
tools: [web_fetch]
allowed_urls: [https://github.blog/changelog/]
max_ai_credits: 1
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
  const directory = join(args[3], ".pinocchio", "jobs", "changelog");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "job.yml"), ${JSON.stringify(manifest)});
} else if (args[0] === "run" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{
    databaseId: 31,
    status: "completed",
    conclusion: "success",
    url: "https://example.test/runs/31",
    createdAt: "2026-09-15T14:00:00Z",
    updatedAt: "2026-09-15T14:02:00Z",
    displayTitle: "Pinocchio - changelog",
    workflowName: "Pinocchio - changelog",
  }]));
} else {
  process.exit(1);
}
`);
  await chmod(gh, 0o700);
  Object.assign(workspace.env, {
    PATH: `${bin}:${workspace.env.PATH}`,
    HOME: home,
    USERPROFILE: home,
    COPILOT_HOME: config,
    COPILOT_CONFIG_DIR: config,
  });
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: fileURLToPath(
        new URL("../node_modules/.bin/copilot", import.meta.url),
      ),
    }),
    mode: "empty",
    workingDirectory: repository,
    baseDirectory: config,
    env: workspace.env,
    useLoggedInUser: false,
    logLevel: "none",
  });
  try {
    await client.start();
    const session = await client.createSession({
      workingDirectory: repository,
      configDirectory: config,
      enableConfigDiscovery: true,
      requestExtensions: true,
      extensionSdkPath: fileURLToPath(
        new URL(".", import.meta.resolve("@github/copilot-sdk")),
      ),
      enableExperimentalMode: true,
      enableManagedSettings: false,
      model: "synthetic-model",
      provider: {
        type: "openai",
        baseUrl: provider.baseUrl,
        wireApi: "completions",
      },
      availableTools: new ToolSet().addCustom("*").addBuiltIn("view"),
      agent: "notice-agent",
      onPermissionRequest: approveAll,
      infiniteSessions: { enabled: false },
    });
    await session.rpc.tools.initializeAndValidate();
    const deadline = Date.now() + 15_000;
    let events = await session.getEvents();
    while (
      Date.now() < deadline &&
      !events.some((event) => event.type === "assistant.message")
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      events = await session.getEvents();
    }
    const user = events.find((event) => event.type === "user.message");
    assert.ok(user && user.type === "user.message");
    assert.equal(user.data.content, "Pinocchio found new cloud job results");
    assert.equal(user.data.delivery, "idle");
    assert.match(user.data.transformedContent ?? "", /changelog: success/);
    assert.ok(events.some((event) => event.type === "assistant.message"));
    let state: { jobs: Record<string, { notifiedThrough: number }> } | undefined;
    for (let attempt = 0; attempt < 20 && !state; attempt++) {
      try {
        state = JSON.parse(
          await readFile(join(cloudHome, "result-state.json"), "utf8"),
        ) as { jobs: Record<string, { notifiedThrough: number }> };
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    assert.ok(state);
    assert.equal(state.jobs.changelog?.notifiedThrough, 31);
    const search = await session.rpc.tools.execute({
      name: EXTENSION_SEARCH_TOOL,
      arguments: { query: "Synthetic check complete" },
    });
    assert.notEqual(typeof search, "string");
    if (typeof search === "string") throw new Error("UNSTRUCTURED_SEARCH");
    assert.equal(search.resultType, "success");
    const result = JSON.parse(search.textResultForLlm) as {
      snippets: unknown[];
    };
    assert.deepEqual(result.snippets, []);
    assert.deepEqual(provider.counts(), {
      requests: 1,
      toolRequests: 0,
      failures: 0,
      failureCodes: [],
    });
    await session.disconnect();
  } finally {
    await client.stop();
    await provider.close();
    await workspace.close();
  }
});
