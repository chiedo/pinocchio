import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { acceptance, releaseVerdict } from "./evaluation.js";
import { hasCode } from "./binding-registry.js";
import { cliInvocation, writeCliError, writeCliResult } from "./cli-output.js";

try {
  const invocation = cliInvocation(process.argv.slice(2));
  const { values } = parseArgs({ args: invocation.args, strict: true, options: {
    reliability: { type: "string" }, live: { type: "string" }, workflow: { type: "string" }, commit: { type: "string" },
  } });
  async function input(path: string | undefined): Promise<unknown> {
    if (!path) return undefined;
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  }
  const [reliability, live, workflow] = await Promise.all([input(values.reliability), input(values.live), input(values.workflow)]);
  const result = releaseVerdict(await acceptance(), values.commit ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), reliability, live, workflow);
  await writeCliResult(result, invocation.json);
  process.exitCode = result.status === "pass" ? 0 : 2;
} catch {
  const invocation = cliInvocation(process.argv.slice(2));
  writeCliError({ code: "RELEASE_INPUT_FAILED" }, invocation.json);
  process.exitCode = 1;
}
