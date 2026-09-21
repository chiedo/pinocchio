import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setup } from "../src/setup-cli.js";

test("existing CLI setup is repeatable, reversible, and preserves native settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-setup-"));
  try {
    const native = '{"model":"unchanged"}\n';
    await writeFile(join(root, "config.json"), native);
    const options = { configRoot: root, name: "synthetic-agent", global: true, retrieval: "keyword" as const };
    assert.equal((await setup(options)).status, "ready");
    const profile = join(root, "agents", "synthetic-agent.agent.md");
    const original = await readFile(profile, "utf8");
    assert.match(original, /pinocchio-memory:v1/);
    assert.ok(original.includes('- Agent ID: "synthetic-agent"'));
    assert.ok(original.includes(`- Agent profile: ${JSON.stringify(profile)}`));
    assert.ok(original.includes(`- Copilot configuration root: ${JSON.stringify(root)}`));
    assert.ok(original.includes('- Put agent-owned local artifacts, including scripts, static files, caches, and local-job support files, under "~/.pinocchio/synthetic-agent/".'));
    assert.ok(original.includes("pinocchio_jobs"));
    assert.ok(original.includes(`Scheduled cloud jobs use this exact local profile as their source: ${JSON.stringify(profile)}`));
    assert.match(original, /Memory scope: global, available across repositories/);
    assert.match(original, /YAML frontmatter configures model preference, tools, and skills/);
    assert.match(original, /authored Markdown defines your role/);
    assert.ok(original.includes(JSON.stringify(join(root, "extensions", "pinocchio-memory", "extension.mjs"))));
    assert.ok(original.includes(JSON.stringify(join(root, "agent-memories"))));
    assert.equal((await setup(options)).status, "ready");
    assert.equal(await readFile(profile, "utf8"), original);
    assert.equal(await readFile(join(root, "config.json"), "utf8"), native);
    await writeFile(profile, original + "\nPreserve this user instruction.\n");
    assert.equal((await setup({ configRoot: root, name: options.name, remove: true })).status, "removed");
    const removed = await readFile(profile, "utf8");
    assert.doesNotMatch(removed, /pinocchio-memory:v1|pinocchio_jobs/);
    assert.match(removed, /Preserve this user instruction/);
    assert.equal((await setup(options)).status, "ready");
    assert.match(await readFile(profile, "utf8"), /pinocchio-memory:v1/);
    await assert.rejects(setup({ ...options, global: false, repository: process.cwd() }), /SETUP_SCOPE_MISMATCH/);
    await assert.rejects(setup({ ...options, name: "../bad" }), /INVALID_ARGUMENTS/);
  } finally { await rm(root, { recursive: true }); }
});

test("agents share one instructions file without overwriting authored rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-shared-"));
  try {
    const shared = join(root, "pinocchio", "AGENTS.md");
    for (const name of ["first", "second"]) {
      const result = await setup({ configRoot: root, name, global: true, retrieval: "keyword" });
      assert.equal(result.sharedInstructions, shared);
      const profile = await readFile(join(root, "agents", `${name}.agent.md`), "utf8");
      assert.ok(profile.includes(`Shared Pinocchio instructions: ${JSON.stringify(shared)}`));
      assert.match(profile, /including delegated helper work/);
      assert.match(profile, /Default instruction edits to your own agent profile, not the shared file/);
      assert.match(profile, /missing or unreadable, report that explicitly/);
      if (name === "first") {
        assert.match(await readFile(shared, "utf8"), /explicitly requests an all-Pinocchio-agent rule/);
        await writeFile(shared, "User-authored shared rule.\n");
      }
    }
    await setup({ configRoot: root, name: "first", global: true, retrieval: "keyword" });
    assert.equal(await readFile(shared, "utf8"), "User-authored shared rule.\n");
    await setup({ configRoot: root, name: "first", remove: true });
    assert.equal(await readFile(shared, "utf8"), "User-authored shared rule.\n");
  } finally { await rm(root, { recursive: true }); }
});

test("setup migrates pre-shared profiles exactly and rejects unsafe shared files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-shared-upgrade-"));
  try {
    const options = { configRoot: root, name: "old-agent", global: true, retrieval: "keyword" as const };
    await setup(options);
    const path = join(root, "agents", "old-agent.agent.md");
    const shared = join(root, "pinocchio", "AGENTS.md");
    const current = await readFile(path, "utf8");
    const previous = current.replace(/- Shared Pinocchio instructions:[\s\S]*?(?=- Copilot configuration root:)/, "");
    assert.notEqual(previous, current);
    await writeFile(path, previous);
    await setup(options);
    assert.equal(await readFile(path, "utf8"), current);
    await rm(shared);
    const target = join(root, "unrelated.md");
    await writeFile(target, "Do not change.\n");
    await symlink(target, shared);
    await assert.rejects(setup(options), { code: "UNSAFE_SHARED_INSTRUCTIONS" });
    assert.equal(await readFile(target, "utf8"), "Do not change.\n");
    assert.equal(await readFile(path, "utf8"), current);
  } finally { await rm(root, { recursive: true }); }
});

test("setup upgrades legacy guidance without changing custom text, CRLF, settings, or binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-setup-$&-"));
  try {
    const options = { configRoot: root, name: "legacy-agent", global: true, retrieval: "keyword" as const };
    await setup(options);
    const profile = join(root, "agents", "legacy-agent.agent.md");
    const receipt = join(root, "pinocchio", "setup", "legacy-agent.json");
    const reference = await readFile(receipt, "utf8");
    const modern = await readFile(profile, "utf8");
    const legacy = (modern
      .replace(/## Your Pinocchio agent\n[\s\S]*?(?=## Persistent memory)/, "")
      .replace("tools:", "# My settings\nmodel: custom-model\nskills: [custom-skill]\ntools:") +
      "\nMy authored workflow stays here.\n").replaceAll("\n", "\r\n");
    assert.doesNotMatch(legacy, /## Your Pinocchio agent/);
    await writeFile(profile, legacy);
    assert.equal((await setup(options)).status, "ready");
    const refreshed = await readFile(profile, "utf8");
    assert.ok(refreshed.includes(`- Agent profile: ${JSON.stringify(profile)}`));
    assert.ok(refreshed.includes(`- Copilot configuration root: ${JSON.stringify(root)}`));
    assert.equal(refreshed.replace(/## Your Pinocchio agent\r\n[\s\S]*?(?=## Persistent memory)/, ""), legacy);
    assert.doesNotMatch(refreshed, /(?<!\r)\n/);
    assert.equal(await readFile(receipt, "utf8"), reference);
    await setup(options);
    assert.equal(await readFile(profile, "utf8"), refreshed);

    const changed = refreshed.replace("<!-- /pinocchio-memory:v1 -->", "<!-- /pinocchio-memory:changed -->");
    assert.notEqual(changed, refreshed);
    await writeFile(profile, changed);
    await assert.rejects(setup(options), { code: "MANAGED_BLOCK_CHANGED" });
    assert.equal(await readFile(profile, "utf8"), changed);
  } finally { await rm(root, { recursive: true }); }
});
