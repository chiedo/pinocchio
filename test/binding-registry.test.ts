import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BindingError, configRootPath, loadBinding, registerBinding, revokeBinding,
} from "../src/binding-registry.js";
import { BoundIdentityAdapter, BINDING_BUDGET_MS } from "../src/bound-identity.js";
import { createBoundMcpServer, BOUND_IDENTITY_TOOL } from "../src/bound-mcp.js";
import { bindingLaunch } from "../src/bindings-cli.js";
import { createProductionFixture } from "./support/production-fixture.js";
import type { BindingReference } from "../src/binding-registry.js";

const fileFor = (ref: BindingReference) =>
  join(ref.configRoot, "pinocchio", "bindings", `${ref.bindingId}.json`);

test("stable namespaces separate identical definition names and origins", async () => {
  const f = await createProductionFixture();
  try {
    const refs = await Promise.all(["foreground", "alpha", "beta"].map(
      (name) => f.bind(name as keyof typeof f.definitions),
    ));
    const records = await Promise.all(refs.map((ref) => loadBinding(ref)));
    assert.equal(new Set(records.map((record) => record.namespace)).size, 3);
    assert.equal(new Set(records.map((record) => record.definition.id)).size, 3);
    for (const record of records) {
      assert.match(record.namespace, /^shared--[a-f0-9]{64}$/);
      assert.equal(record.definition.path.endsWith("/shared.agent.md"), true);
    }
    const first = records[0];
    assert.ok(first);
    await writeFile(first.definition.path, "---\nname: changed-display\nmodel: synthetic\n---\nEdited prompt.\n");
    const renewed = await loadBinding(await f.bind("foreground"));
    assert.equal(renewed.namespace, first.namespace);
    assert.equal(renewed.definition.id, first.definition.id);
    assert.notEqual(renewed.id, first.id);
    const samePathOtherOrigin = await loadBinding(await registerBinding({
      configRoot: f.config, origin: "plugin", originRoot: f.definitions.foreground.root,
      definitionPath: first.definition.path, scope: { kind: "global" },
    }));
    assert.notEqual(samePathOtherOrigin.definition.id, first.definition.id);
  } finally { await f.close(); }
});

test("repository and global scopes are explicit and cannot be interchanged", async () => {
  const f = await createProductionFixture();
  try {
    const first = await loadBinding(await f.bind("alpha"));
    const global = await loadBinding(await f.bind("alpha", { kind: "global" }));
    const other = await loadBinding(await f.bind("alpha", { kind: "repository", root: f.otherRepository }));
    assert.equal(first.namespace, global.namespace);
    assert.equal(first.namespace, other.namespace);
    assert.deepEqual(global.scope, { kind: "global", key: "global" });
    assert.notEqual(first.scope.key, other.scope.key);
    assert.notEqual(first.scope.key, global.scope.key);
  } finally { await f.close(); }
});

test("a live adapter cannot be retargeted by mutating its launch reference", async () => {
  const f = await createProductionFixture();
  try {
    const alpha = await f.bind("alpha");
    const beta = await f.bind("beta");
    const adapter = new BoundIdentityAdapter(alpha);
    const original = await adapter.resolve();
    assert.equal(original.status, "bound");
    Object.assign(alpha, beta);
    const after = await adapter.resolve();
    assert.deepEqual(after, original);
    if (after.status === "bound") {
      assert.ok(Object.isFrozen(after.identity));
      assert.ok(Object.isFrozen(after.identity.scope));
    }
  } finally { await f.close(); }
});

test("custom roots, registry permissions and durable concurrent registration", async () => {
  const f = await createProductionFixture();
  try {
    assert.equal(configRootPath(undefined, { COPILOT_HOME: f.config }), f.config);
    assert.equal(configRootPath(undefined, { COPILOT_CONFIG_DIR: f.config }), f.config);
    assert.throws(() => configRootPath(undefined, {
      COPILOT_HOME: f.config, COPILOT_CONFIG_DIR: f.repository,
    }), /AMBIGUOUS_CONFIG_ROOT/);
    assert.equal(configRootPath(f.config, {
      COPILOT_HOME: f.repository, COPILOT_CONFIG_DIR: f.otherRepository,
    }), f.config);
    const refs = await Promise.all(Array.from({ length: 8 }, () => f.bind("foreground")));
    assert.equal(new Set(refs.map((ref) => ref.bindingId)).size, 8);
    const records = await Promise.all(refs.map((ref) => loadBinding(ref)));
    assert.equal(new Set(records.map((record) => record.namespace)).size, 1);
    for (const ref of refs) assert.equal((await stat(fileFor(ref))).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.config, "pinocchio", "bindings"))).mode & 0o777, 0o700);
    const ref = refs[0];
    assert.ok(ref);
    await chmod(fileFor(ref), 0o644);
    assert.deepEqual(await new BoundIdentityAdapter(ref).resolve(), {
      status: "unavailable", code: "INSECURE_REGISTRY",
    });
  } finally { await f.close(); }
});

test("canonical paths normalize aliases and definition moves require a new identity", async () => {
  const f = await createProductionFixture();
  try {
    const original = await f.bind("foreground");
    const record = await loadBinding(original);
    const alias = join(f.repository, "definition-alias");
    await symlink(f.definitions.foreground.root, alias);
    const canonical = await loadBinding(await registerBinding({
      configRoot: f.config, origin: "project", originRoot: alias,
      definitionPath: join(alias, "shared.agent.md"), scope: { kind: "global" },
    }));
    assert.equal(canonical.definition.id, record.definition.id);
    await rename(record.definition.path, join(f.definitions.foreground.root, "renamed.agent.md"));
    assert.equal((await new BoundIdentityAdapter(original).resolve()).status, "unavailable");
    const renamed = await loadBinding(await registerBinding({
      configRoot: f.config, origin: "project", originRoot: f.definitions.foreground.root,
      definitionPath: join(f.definitions.foreground.root, "renamed.agent.md"),
      scope: { kind: "global" },
    }));
    assert.notEqual(renamed.definition.id, record.definition.id);
    await assert.rejects(registerBinding({
      configRoot: f.config, origin: "project", originRoot: f.definitions.foreground.root,
      definitionPath: join(f.definitions.alpha.root, "shared.agent.md"),
      scope: { kind: "global" },
    }), /INVALID_DEFINITION/);
  } finally { await f.close(); }
});

test("unknown, malformed, edited and symlinked registrations never resolve", async () => {
  const f = await createProductionFixture();
  try {
    const ref = await f.bind("alpha");
    const text = await readFile(fileFor(ref), "utf8");
    const invalid = [
      { ...ref, bindingId: "../foreign" },
      { ...ref, fingerprint: "" },
      { ...ref, bindingId: "00000000-0000-4000-8000-000000000000" },
      { ...ref, fingerprint: "0".repeat(64) },
    ];
    for (const reference of invalid) {
      const result = await new BoundIdentityAdapter(reference).resolve();
      assert.equal(result.status, "unavailable");
      assert.equal(Object.hasOwn(result, "identity"), false);
    }
    await writeFile(fileFor(ref), text.replace('"user"', '"plugin"'));
    assert.deepEqual(await new BoundIdentityAdapter(ref).resolve(), {
      status: "unavailable", code: "STALE_BINDING",
    });
    await rm(fileFor(ref));
    await symlink(join(f.definitions.alpha.root, "shared.agent.md"), fileFor(ref));
    assert.deepEqual(await new BoundIdentityAdapter(ref).resolve(), {
      status: "unavailable", code: "INSECURE_REGISTRY",
    });
  } finally { await f.close(); }
});

test("revocation survives a new adapter while replacement bindings keep identity", async () => {
  const f = await createProductionFixture();
  try {
    const ref = await f.bind("beta");
    const before = await new BoundIdentityAdapter(ref).resolve();
    assert.equal(before.status, "bound");
    await revokeBinding(ref);
    await revokeBinding(ref);
    assert.deepEqual(await new BoundIdentityAdapter(ref).resolve(), {
      status: "unavailable", code: "REVOKED_BINDING",
    });
    const renewed = await new BoundIdentityAdapter(await f.bind("beta")).resolve();
    assert.equal(renewed.status, "bound");
    if (renewed.status === "bound" && before.status === "bound") {
      assert.deepEqual(renewed.identity, before.identity);
    }
  } finally { await f.close(); }
});

test("in-flight revocation discards a completed operation's result", async () => {
  const f = await createProductionFixture();
  try {
    const ref = await f.bind("foreground");
    const adapter = new BoundIdentityAdapter(ref);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = adapter.withIdentity(async () => {
      entered(); await gate; return "synthetic-private-result";
    });
    await started;
    await revokeBinding(ref);
    release();
    assert.deepEqual(await pending, { status: "unavailable", code: "REVOKED_BINDING" });
  } finally { await f.close(); }
});

test("a removed definition can be revoked before its path is reused", async () => {
  const f = await createProductionFixture();
  try {
    const ref = await f.bind("alpha");
    const path = join(f.definitions.alpha.root, "shared.agent.md");
    await rm(path);
    await revokeBinding(ref);
    await writeFile(path, "Recreated synthetic definition.");
    assert.deepEqual(await new BoundIdentityAdapter(ref).resolve(), {
      status: "unavailable", code: "REVOKED_BINDING",
    });
  } finally { await f.close(); }
});

test("deadlines, cancellation, disposal and failures never deliver operation values", async () => {
  const f = await createProductionFixture();
  try {
    const ref = await f.bind("foreground");
    const adapter = new BoundIdentityAdapter(ref);
    const start = performance.now();
    let lateSignal: AbortSignal | undefined;
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => { finish = resolve; });
    const result = await adapter.withIdentity(async (_, signal) => {
      lateSignal = signal;
      await delayed;
      return "late-value";
    });
    assert.deepEqual(result, { status: "unavailable", code: "BINDING_DEADLINE" });
    assert.ok(performance.now() - start >= BINDING_BUDGET_MS - 20);
    assert.ok(performance.now() - start < 1_000);
    assert.equal(lateSignal?.aborted, true);
    finish();
    await setTimeout(10);
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await adapter.resolve(controller.signal), {
      status: "unavailable", code: "CALL_CANCELLED",
    });
    assert.deepEqual(await adapter.withIdentity(async () => { adapter.dispose(); return 1; }), {
      status: "unavailable", code: "ADAPTER_DISPOSED",
    });
    assert.deepEqual(await adapter.resolve(), { status: "unavailable", code: "ADAPTER_DISPOSED" });
    assert.deepEqual(await new BoundIdentityAdapter(ref).withIdentity(async () => {
      throw new Error("synthetic-detail-not-for-diagnostics");
    }), { status: "unavailable", code: "OPERATION_FAILED" });
  } finally { await f.close(); }
});

test("repository replacement invalidates a pinned binding", async () => {
  const f = await createProductionFixture();
  try {
    const ref = await f.bind("foreground");
    const git = join(f.repository, ".git");
    await rename(git, join(f.repository, "old-git"));
    await symlink(join(f.otherRepository, ".git"), git);
    assert.deepEqual(await new BoundIdentityAdapter(ref).resolve(), {
      status: "unavailable", code: "STALE_BINDING",
    });
  } finally { await f.close(); }
});

test("production MCP rejects owner/scope arguments and reports revocation", async () => {
  const f = await createProductionFixture();
  const ref = await f.bind("foreground");
  const server = createBoundMcpServer(ref);
  const client = new Client({ name: "synthetic-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools[0]?.inputSchema, {
      type: "object", properties: {}, additionalProperties: false,
    });
    const ok = await client.callTool({ name: BOUND_IDENTITY_TOOL, arguments: {} });
    assert.equal(ok.isError, false);
    for (const args of [{ owner: "other" }, { scope: "global" }, { namespace: "other" }]) {
      const response = await client.callTool({ name: BOUND_IDENTITY_TOOL, arguments: args });
      assert.equal(response.isError, true);
      assert.ok(JSON.stringify(response).includes("INVALID_TOOL_ARGUMENTS"));
      assert.equal(JSON.stringify(response).includes("definitionId"), false);
    }
    await revokeBinding(ref);
    const denied = await client.callTool({ name: BOUND_IDENTITY_TOOL, arguments: {} });
    assert.equal(denied.isError, true);
    assert.ok(JSON.stringify(denied).includes("REVOKED_BINDING"));
    assert.equal(JSON.stringify(denied).includes(ref.configRoot), false);
  } finally { await client.close(); await server.close(); await f.close(); }
});

test("CLI registration/status is durable across separate processes", async () => {
  const f = await createProductionFixture();
  async function run(args: string[]) {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../src/bindings-cli.js", import.meta.url)), ...args,
    ], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("exit", resolve);
    });
    return { code, stdout, stderr };
  }
  try {
    const result = await run([
      "bind", "--config-root", f.config, "--definition",
      join(f.definitions.foreground.root, "shared.agent.md"),
      "--origin", "project", "--origin-root", f.definitions.foreground.root,
      "--repository", f.repository,
    ]);
    assert.equal(result.code, 0);
    const data = JSON.parse(result.stdout) as { reference: BindingReference };
    const launch = bindingLaunch(data.reference);
    const referenceArgs = launch.args.slice(2);
    assert.equal((await run(["status", ...referenceArgs])).code, 0);
    assert.equal((await run(["revoke", ...referenceArgs])).code, 0);
    const revoked = await run(["status", ...referenceArgs]);
    assert.equal(revoked.code, 1);
    assert.match(revoked.stdout, /REVOKED_BINDING/);
    const invalid = await run(["bind", "--definition", "synthetic-only"]);
    assert.equal(invalid.code, 1);
    assert.equal(invalid.stderr.trim(), "Pinocchio: INVALID_BINDING");
  } finally { await f.close(); }
});

test("known errors remain explicit and content-free", () => {
  const error = new BindingError("INVALID_BINDING");
  assert.equal(error.message, "INVALID_BINDING");
});
