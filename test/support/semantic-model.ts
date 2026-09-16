import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { main as prepare } from "../../src/semantic-cli.js";
import { semanticConfig, writeAtomic } from "../../src/semantic-files.js";
import { SemanticProcess } from "../../src/semantic-process.js";
import { MODEL_ID, type SemanticConfig } from "../../src/semantic-types.js";

export async function prepareTestSemanticModel(root: string) {
  const python = process.env.PINOCCHIO_TEST_PYTHON;
  if (!python) throw new Error("PINOCCHIO_TEST_PYTHON_REQUIRED");
  const shared = process.env.PINOCCHIO_TEST_MODEL_DIRECTORY;
  if (!shared) {
    await prepare(["prepare", "--config-root", root, "--python", python]);
    return semanticConfig(root);
  }
  const config: SemanticConfig = {
    version: 1,
    python: join(await realpath(dirname(python)), basename(python)),
    modelDirectory: await realpath(shared),
    model: MODEL_ID,
  };
  const engine = new SemanticProcess(config);
  try {
    await engine.ready();
  } finally {
    engine.close();
  }
  await mkdir(join(root, "pinocchio"), { recursive: true, mode: 0o700 });
  await writeAtomic(join(root, "pinocchio", "semantic.json"), config);
  return config;
}
