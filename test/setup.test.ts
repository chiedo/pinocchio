import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setup } from "../src/setup-cli.js";

test("existing CLI setup is repeatable, reversible, and preserves native settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-setup-"));
  try {
    const native = '{"model":"unchanged"}\n';
    await writeFile(join(root, "config.json"), native);
    const options = { configRoot: root, name: "synthetic-agent", global: true };
    assert.equal((await setup(options)).status, "ready");
    const profile = join(root, "agents", "synthetic-agent.agent.md");
    const original = await readFile(profile, "utf8");
    assert.match(original, /pinocchio-memory:v1/);
    assert.equal((await setup(options)).status, "ready");
    assert.equal(await readFile(profile, "utf8"), original);
    assert.equal(await readFile(join(root, "config.json"), "utf8"), native);
    await writeFile(profile, original + "\nPreserve this user instruction.\n");
    assert.equal((await setup({ ...options, remove: true })).status, "removed");
    const removed = await readFile(profile, "utf8");
    assert.doesNotMatch(removed, /pinocchio-memory:v1/);
    assert.match(removed, /Preserve this user instruction/);
    assert.equal((await setup(options)).status, "ready");
    assert.match(await readFile(profile, "utf8"), /pinocchio-memory:v1/);
    await assert.rejects(setup({ ...options, global: false, repository: process.cwd() }), /SETUP_SCOPE_MISMATCH/);
    await assert.rejects(setup({ ...options, name: "../bad" }), /INVALID_ARGUMENTS/);
  } finally { await rm(root, { recursive: true }); }
});
