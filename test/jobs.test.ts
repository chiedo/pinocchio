import assert from "node:assert/strict";
import test from "node:test";
import { JOBS_TOOL, jobsToolInputSchema } from "../src/jobs.js";
import { LOCAL_JOBS_COMPATIBILITY, localJobsUnavailable } from "../src/jobs-compatibility.js";

test("unified jobs input exposes the agent-owned tool and local compatibility gate", () => {
  assert.equal(JOBS_TOOL, "pinocchio_jobs");
  const preview = jobsToolInputSchema.parse({
    action: "preview",
    backend: "cloud",
    repository: "example/research-jobs",
    id: "release-summary",
    prompt: "Summarize approved sources.",
    cron: "15 10 * * 1-5",
  });
  assert.equal(preview.backend, "cloud");
  assert.equal(preview.repository, "example/research-jobs");
  const unavailable = localJobsUnavailable();
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.compatibility, LOCAL_JOBS_COMPATIBILITY);
  assert.equal(unavailable.compatibility.code, "LOCAL_BACKGROUND_TASK_API_UNAVAILABLE");
});
