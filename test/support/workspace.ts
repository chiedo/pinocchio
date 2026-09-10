import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export async function createWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "pinocchio-public-host-"));
  const home = join(root, "home");
  const config = join(home, ".copilot");
  const repository = join(root, "repository");
  const otherRepository = join(root, "other-repository");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    COPILOT_HOME: config,
    COPILOT_CONFIG_DIR: config,
    TMPDIR: root,
    NO_COLOR: "1",
    CI: "true",
    DO_NOT_TRACK: "1",
    COPILOT_TELEMETRY_DISABLED: "1",
  };
  await mkdir(config, { recursive: true });
  for (const directory of [repository, otherRepository]) {
    await mkdir(join(directory, ".github", "extensions"), { recursive: true });
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", directory], {
      env,
      stdio: "pipe",
    });
    await cp(
      new URL("../../../.github/extensions/pinocchio", import.meta.url),
      join(directory, ".github", "extensions", "pinocchio"),
      { recursive: true },
    );
    await cp(new URL("../../src", import.meta.url), join(directory, "dist", "src"), {
      recursive: true,
    });
  }
  return {
    repository,
    otherRepository,
    config,
    env,
    async close() {
      // Only the exact temporary directory created by this fixture is removed.
      await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
