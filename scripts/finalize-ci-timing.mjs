import { readFile, writeFile } from "node:fs/promises";

const path = "test-results/ci-timing.json";
const summary = JSON.parse(await readFile(path, "utf8"));
const startedAt = Number(process.env.PINOCCHIO_CI_STARTED_AT);
if (!Number.isFinite(startedAt) || startedAt <= 0) {
  throw new Error("CI_START_TIME_MISSING");
}
summary.requiredElapsedMs = Date.now() - startedAt;
summary.packagingCompleted = summary.status === "passed";
summary.finishedAt = new Date().toISOString();
await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`);
