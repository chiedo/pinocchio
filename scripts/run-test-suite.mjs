import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";

const concurrency = Number.parseInt(
  process.env.PINOCCHIO_TEST_CONCURRENCY ?? "4",
  10,
);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
  throw new Error("INVALID_TEST_CONCURRENCY");
}

async function run(command, args) {
  const started = performance.now();
  const child = spawn(command, args, {
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, durationMs: performance.now() - started, stdout };
}

function version(command) {
  if (!command) return null;
  try {
    return execFileSync(command, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function tapSummary(output) {
  const summary = {};
  for (const match of output.matchAll(
    /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$/gm,
  )) {
    summary[match[1]] = Number(match[2]);
  }
  return summary;
}

function tapDurations(output) {
  const results = [];
  let pending;
  let current;
  for (const line of output.split("\n")) {
    const subtest = /^# Subtest: (.+)$/.exec(line);
    if (subtest) {
      pending = subtest[1];
      continue;
    }
    const result = /^(ok|not ok) \d+ - (.+)$/.exec(line);
    if (result) {
      current = {
        name: pending ?? result[2],
        status: result[1] === "ok" ? "passed" : "failed",
      };
      pending = undefined;
      continue;
    }
    const duration = /^\s+duration_ms: ([\d.]+)$/.exec(line);
    if (duration && current) {
      results.push({
        ...current,
        durationMs: Math.round(Number(duration[1])),
      });
      current = undefined;
    }
  }
  return results.sort((left, right) => right.durationMs - left.durationMs);
}

const build = await run(process.execPath, [
  join("node_modules", "typescript", "bin", "tsc"),
]);
let tests = { code: null, durationMs: 0, stdout: "" };
let model = { code: 0, durationMs: 0, stdout: "" };
let testFiles = [];
if (build.code === 0) {
  if (process.env.PINOCCHIO_TEST_MODEL_CACHE) {
    await mkdir(process.env.PINOCCHIO_TEST_MODEL_CACHE, {
      recursive: true,
      mode: 0o700,
    });
    model = await run(process.env.PINOCCHIO_TEST_PYTHON, [
      join("semantic", "engine.py"),
      "prepare",
      process.env.PINOCCHIO_TEST_MODEL_CACHE,
    ]);
    if (model.code === 0) {
      process.env.PINOCCHIO_TEST_MODEL_DIRECTORY =
        process.env.PINOCCHIO_TEST_MODEL_CACHE;
    }
  }
}
if (build.code === 0 && model.code === 0) {
  testFiles = (await readdir(join("dist", "test")))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join("dist", "test", name));
  tests = await run(process.execPath, [
    "--test",
    `--test-concurrency=${concurrency}`,
    ...testFiles,
  ]);
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const scenarios = [
  ...new Set(
    [...tests.stdout.matchAll(/^# Subtest: (.+)$/gm)].map((match) => match[1]),
  ),
].sort();
const summary = {
  schemaVersion: 1,
  status: build.code === 0 && model.code === 0 && tests.code === 0
    ? "passed"
    : "failed",
  commit: process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  run: {
    id: process.env.GITHUB_RUN_ID ?? null,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
    ref: process.env.GITHUB_REF ?? null,
  },
  runner: {
    os: process.platform,
    arch: process.arch,
    availableParallelism: availableParallelism(),
    image: process.env.ImageOS ?? null,
  },
  versions: {
    node: process.version,
    cli: packageJson.dependencies["@github/copilot"],
    sdk: packageJson.dependencies["@github/copilot-sdk"],
    python: version(process.env.PINOCCHIO_TEST_PYTHON),
  },
  cache: {
    npm: process.env.PINOCCHIO_NPM_CACHE_HIT ?? "unknown",
    pip: process.env.PINOCCHIO_PIP_CACHE_HIT ?? "unknown",
    model: process.env.PINOCCHIO_MODEL_CACHE_HIT ?? "unknown",
    playwright: process.env.PINOCCHIO_PLAYWRIGHT_CACHE_HIT ?? "unknown",
  },
  concurrency,
  testFiles: testFiles.map((name) => basename(name)),
  scenarios,
  testDurations: tapDurations(tests.stdout),
  counts: tapSummary(tests.stdout),
  phasesMs: {
    build: Math.round(build.durationMs),
    model: Math.round(model.durationMs),
    tests: Math.round(tests.durationMs),
    total: Math.round(build.durationMs + model.durationMs + tests.durationMs),
  },
};
await mkdir("test-results", { recursive: true });
await writeFile(
  join("test-results", "ci-timing.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);

process.exitCode = build.code !== 0
  ? build.code ?? 1
  : model.code !== 0
    ? model.code ?? 1
    : tests.code ?? 1;
