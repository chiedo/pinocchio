import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { main } from "../src/install-cli.js";
import { JOBS_TOOL } from "../src/jobs.js";
import { packageRelease, releaseRoot, verifyRelease } from "../src/release.js";
import { MemoryStore } from "../src/memory-store.js";
import {
  EXTENSION_SAVE_TOOL,
  EXTENSION_SEARCH_TOOL,
} from "../src/memory-protocol.js";
import { loadBinding } from "../src/binding-registry.js";
import type { BindingReference } from "../src/binding-registry.js";

const execute = promisify(execFile);
test("release payload is pinned and rejects added files and tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-release-test-"));
  try {
    const bundle = join(root, "bundle");
    await packageRelease(bundle, "a".repeat(40));
    const release = await verifyRelease(bundle);
    assert.equal(release.cli, "1.0.83");
    assert.equal(release.liveCertification, "unvalidated");
    await writeFile(join(bundle, "README.md"), "changed");
    await assert.rejects(verifyRelease(bundle), /RELEASE_HASH_MISMATCH/);
    await writeFile(join(bundle, "unexpected"), "not in manifest");
    await assert.rejects(verifyRelease(bundle), /RELEASE_CONTENT_MISMATCH/);
  } finally { await rm(root, { recursive: true }); }
});

test("clean custom-root install, native CLI diagnostic and reversible agent lifecycle", { timeout: 480_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-installer-test-"));
  const config = join(root, "custom root");
  let passed = false;
  const cases: string[] = [];
  const timings: Record<string, unknown> = {};
  try {
    await mkdir(config, { mode: 0o700 });
    const nativeConfig = '{"model":"synthetic-native-default","memory":{"enabled":false}}\n';
    await writeFile(join(config, "config.json"), nativeConfig);
    timings.install = await main(["install", "--config-root", config]);
    cases.push("clean-install-with-custom-root", "native-cli-save-new-session-helper-recall-delete");
    const app = join(config, "pinocchio-runtime", "app");
    const cli = join(app, "dist/src/install-cli.js");
    async function installed(...args: string[]) {
      const result = await execute(process.execPath, [cli, "--config-root", config, ...args],
        { cwd: root, timeout: 30_000, maxBuffer: 16_384 });
      return JSON.parse(result.stdout) as Record<string, unknown>;
    }
    const created = await installed("create", "--name", "synthetic-agent", "--global", "--tools", "view,task");
    assert.ok(created.reference);
    const reference = created.reference as BindingReference;
    const binding = await loadBinding(reference);
    const profile = join(config, "agents/synthetic-agent.agent.md");
    let text = await readFile(profile, "utf8");
    const installedProfile = parse(text.split("---")[1] ?? "") as {
      tools?: unknown[];
      "mcp-servers"?: Record<string, { args?: string[] }>;
    };
    for (const tool of [EXTENSION_SEARCH_TOOL, EXTENSION_SAVE_TOOL, JOBS_TOOL]) {
      assert.ok(installedProfile.tools?.includes(tool));
    }
    assert.equal(installedProfile["mcp-servers"], undefined);
    const extension = await readFile(join(config, "extensions/pinocchio-memory/extension.mjs"), "utf8");
    assert.ok(extension.includes(pathToFileURL(join(app, "dist/src/memory-extension.js")).href));
    assert.ok(!text.includes(releaseRoot));
    text = text.replace("description: Named agent with scoped memory",
      "description: A later user edit\nmodel: synthetic-personal-model") + "\nPreserve these later instructions.\n";
    await writeFile(profile, text);
    cases.push("blank-session-agent-creation", "runtime-independent-of-checkout");
    const store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: "global" });
    try {
      await store.remember({ content: "synthetic retained record", kind: "fact",
        evidence: [{ kind: "manual_entry", reference: { type: "text", value: "invented" } }] }, "synthetic-retained");
      await installed("disable");
      assert.equal((await store.status()).disabled, true);
      await installed("enable");
      assert.equal((await store.status()).disabled, false);
      await store.setDisabled(true, "user-disabled");
      await installed("disable");
      await installed("enable");
      assert.equal((await store.status()).disabled, true);
      cases.push("disable-preserves-records-and-existing-disable-setting");
    } finally { store.close(); }
    await assert.rejects(installed("create", "--name", "../bad", "--global"));
    await assert.rejects(installed("uninstall"));
    await assert.rejects(main(["upgrade", "--config-root", config]), /UPGRADE_REQUIRES/);
    timings.upgrade = await main(["upgrade", "--config-root", config, "--host-stopped"]);
    assert.equal((await installed("status")).rollbackAvailable, true);
    await installed("rollback", "--host-stopped");
    assert.equal(await readFile(profile, "utf8"), text);
    await installed("discard-previous", "--host-stopped");
    assert.equal((await installed("status")).rollbackAvailable, false);
    cases.push("same-schema-upgrade-rollback-preserves-profiles");
    await installed("uninstall", "--host-stopped");
    const after = await readFile(profile, "utf8");
    assert.ok(after.includes("Preserve these later instructions."));
    assert.ok(!after.includes("pinocchio-memory:v1"));
    const frontmatter = parse(after.split("---")[1] ?? "") as Record<string, unknown>;
    assert.equal(frontmatter.model, "synthetic-personal-model");
    assert.deepEqual(frontmatter.tools, ["view", "task"]);
    assert.equal(await readFile(join(config, "config.json"), "utf8"), nativeConfig);
    const retained = await MemoryStore.open(reference, { namespace: binding.namespace, scope: "global" });
    try { assert.equal((await retained.operationStatus("synthetic-retained")).status, "committed"); }
    finally { retained.close(); }
    cases.push("uninstall-preserves-records-profiles-native-config");
    passed = true;
  } finally {
    await rm(root, { recursive: true, force: true });
    await mkdir("test-results", { recursive: true });
    await writeFile("test-results/installation.json", JSON.stringify({
      passed, cases, platform: process.platform, arch: process.arch, cli: "1.0.83",
      timings,
      liveCertification: "unvalidated", desktop: "unvalidated",
    }, null, 2) + "\n");
  }
});
