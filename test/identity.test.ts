import assert from "node:assert/strict";
import test from "node:test";
import type { ToolInvocation } from "@github/copilot-sdk";
import { CopilotIdentityAdapter } from "../src/copilot-identity.js";
import { IDENTITY_DEADLINE_MS } from "../src/identity.js";
import { createIdentityTool, IDENTITY_TOOL_NAME } from "../src/tool.js";

const invocation: ToolInvocation = {
  sessionId: "synthetic-session",
  toolCallId: "synthetic-call",
  toolName: IDENTITY_TOOL_NAME,
  arguments: {},
};

function assertNoNamespace(value: unknown): void {
  assert.equal(JSON.stringify(value).includes('"namespace"'), false);
  assert.equal(JSON.stringify(value).includes('"owner"'), false);
}

test("valid public call metadata is explicitly unsupported, not a namespace", () => {
  const result = new CopilotIdentityAdapter().resolveCall(invocation);
  assert.equal(result.status, "unsupported");
  assert.equal(result.code, "HOST_IDENTITY_UNSUPPORTED");
  assert.deepEqual(result.scopes, {
    repository: "unavailable",
    global: "unavailable",
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.scopes));
  assertNoNamespace(result);
});

test("missing, malformed and inherited host metadata fails closed", () => {
  const adapter = new CopilotIdentityAdapter();
  const invalid: unknown[] = [
    undefined,
    null,
    [],
    {},
    { ...invocation, sessionId: "" },
    { ...invocation, sessionId: " " },
    { ...invocation, toolCallId: 1 },
    { ...invocation, toolName: null },
    { ...invocation, signal: { aborted: false } },
    Object.create(invocation),
  ];
  for (const input of invalid) {
    assert.equal(adapter.resolveCall(input).code, "INVALID_HOST_CONTEXT");
  }
});

test("named helpers, duplicate names and origins never grant ownership", () => {
  const adapter = new CopilotIdentityAdapter();
  for (const [definition, origin] of [
    ["foreground", "project"],
    ["helper-alpha", "project"],
    ["helper-beta", "user"],
    ["helper-alpha", "plugin"],
  ]) {
    const result = adapter.resolveCall({
      ...invocation,
      agentId: definition,
      agentName: "shared-display-name",
      definitionId: definition,
      definitionOrigin: origin,
      repositoryId: "synthetic-repository",
      parentAgent: "foreground",
    });
    assert.equal(result.code, "HOST_IDENTITY_UNSUPPORTED");
    assertNoNamespace(result);
  }
});

test("foreground changes and concurrent calls cannot retarget a result", async () => {
  const adapter = new CopilotIdentityAdapter();
  const mutable = { ...invocation, selectedAgent: "foreground" };
  const first = adapter.resolveCall(mutable);
  mutable.selectedAgent = "helper-alpha";
  mutable.sessionId = "another-synthetic-session";
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      Promise.resolve(
        adapter.resolveCall({
          ...mutable,
          toolCallId: `synthetic-call-${index}`,
        }),
      ),
    ),
  );
  for (const result of [first, ...results]) {
    assert.equal(result.code, "HOST_IDENTITY_UNSUPPORTED");
    assertNoNamespace(result);
  }
});

test("cancelled and disposed calls are visibly unavailable", () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = new CopilotIdentityAdapter();
  assert.equal(
    adapter.resolveCall({ ...invocation, signal: controller.signal }).code,
    "CALL_CANCELLED",
  );
  adapter.dispose();
  assert.equal(adapter.resolveCall(invocation).code, "STALE_ADAPTER");
  adapter.dispose();
  assert.equal(adapter.resolveCall(invocation).code, "STALE_ADAPTER");
});

test("reload and resume cannot recover a guessed or stale namespace", () => {
  const old = new CopilotIdentityAdapter();
  const before = old.resolveCall(invocation);
  old.dispose();
  const replacement = new CopilotIdentityAdapter();
  assert.equal(old.resolveCall(invocation).code, "STALE_ADAPTER");
  assert.deepEqual(replacement.resolveCall(invocation), before);
  assert.deepEqual(
    replacement.resolveCall({
      ...invocation,
      sessionId: "synthetic-resumed-session",
    }),
    before,
  );
});

test("missing and delayed metadata return synchronously within the deadline", () => {
  const adapter = new CopilotIdentityAdapter();
  const metadata: Record<string, unknown> = {};
  const start = performance.now();
  const missing = adapter.resolveCall(metadata);
  assert.equal(missing.code, "INVALID_HOST_CONTEXT");
  Object.assign(metadata, invocation);
  const late = adapter.resolveCall(metadata);
  assert.equal(late.code, "HOST_IDENTITY_UNSUPPORTED");
  assert.equal(missing.code, "INVALID_HOST_CONTEXT");
  assert.ok(performance.now() - start < IDENTITY_DEADLINE_MS);
  assert.equal(missing instanceof Promise, false);
});

test("the tool has no owner/scope inputs and rejects model-supplied metadata", async () => {
  const tool = createIdentityTool();
  assert.deepEqual(tool.parameters, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.ok(tool.handler);
  for (const args of [
    { owner: "foreground" },
    { namespace: "helper-alpha" },
    { scope: "global" },
    { invocation },
    { ...invocation },
    [],
    null,
    undefined,
  ]) {
    const result = await tool.handler(args, invocation);
    assert.equal(result.resultType, "failure");
    assert.equal(result.error, "INVALID_TOOL_ARGUMENTS");
    assertNoNamespace(JSON.parse(result.textResultForLlm));
  }
});

test("normal tool calls report failure visibly without echoing host metadata", async () => {
  const tool = createIdentityTool();
  assert.ok(tool.handler);
  const start = performance.now();
  const result = await tool.handler({}, invocation);
  assert.equal(result.resultType, "failure");
  assert.equal(result.error, "HOST_IDENTITY_UNSUPPORTED");
  assert.match(result.sessionLog ?? "", /No namespace was selected/);
  assert.ok(performance.now() - start < IDENTITY_DEADLINE_MS);
  assert.equal(JSON.stringify(result).includes(invocation.sessionId), false);
  assert.equal(JSON.stringify(result).includes(invocation.toolCallId), false);
});
