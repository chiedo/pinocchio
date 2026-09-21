import assert from "node:assert/strict";
import test from "node:test";
import { formatCliError, formatCliResult, serializedCliResult } from "../src/cli-output.js";

test("CLI output summarizes agent setup for people and preserves explicit JSON", () => {
  const result = {
    status: "ready",
    agents: [
      { agent: "builder", bindingId: "binding-1", status: "ready", mode: "hybrid", vectors: 16, model: "model-1" },
      { agent: "reviewer", bindingId: "binding-2", status: "ready", mode: "hybrid", vectors: 69, model: "model-1" },
    ],
  };
  const human = formatCliResult(result);
  assert.match(human, /Status: Ready/);
  assert.match(human, /Agents: 2 ready; 85 vectors/);
  assert.match(human, /- builder: ready, hybrid, 16 vectors/);
  assert.deepEqual(JSON.parse(serializedCliResult(result, true)), result);
});

test("CLI errors explain the problem and retain the stable code", () => {
  const output = formatCliError({
    code: "INVALID_ARGUMENTS",
    repair: "Run the command again with a supported option.",
  });
  assert.match(output, /Error: The command or one of its options is invalid\./);
  assert.match(output, /Code: INVALID_ARGUMENTS/);
  assert.match(output, /How to fix: Run the command again/);
});
