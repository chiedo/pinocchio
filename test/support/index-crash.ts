import { readFile } from "node:fs/promises";
import type { BindingReference } from "../../src/binding-registry.js";
import { rebuildIndex } from "../../src/semantic-index.js";

const reference: BindingReference = JSON.parse(await readFile(process.argv[2] ?? "", "utf8"));
await rebuildIndex(reference, async (phase) => {
  if (phase === process.argv[3]) process.kill(process.pid, "SIGKILL");
});
throw new Error("CRASH_POINT_NOT_REACHED");
