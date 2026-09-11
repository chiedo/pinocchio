import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { loadBinding } from "../../src/binding-registry.js";
import type { BindingReference } from "../../src/binding-registry.js";
import { MemoryStore } from "../../src/memory-store.js";
import { MemoryError } from "../../src/memory-types.js";

const reference: BindingReference = JSON.parse(await readFile(process.argv[2] ?? "", "utf8"));
const binding = await loadBinding(reference);
const store = await MemoryStore.open(reference, { namespace: binding.namespace, scope: binding.scope.kind });
try {
  const action = process.argv[3];
  if (action === "crash") {
    const path = store.path;
    store.close();
    const db = new DatabaseSync(path);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE revisions SET content=?").run("synthetic uncommitted change");
    process.exit(0);
  }
  const input = {
    content: "synthetic restart note",
    kind: "fact" as const,
    evidence: [{ kind: "manual_entry" as const, reference: { type: "text" as const, value: "synthetic fixture" } }],
  };
  const receipt = action === "correct"
    ? await store.correct(process.argv[4] ?? "", 1, input, process.argv[5] ?? "")
    : action === "forget" ? await store.forget(process.argv[4] ?? "", 1, process.argv[5] ?? "")
    : await store.remember(input, "child-save");
  store.close();
  if (action === "lost-ack") process.exit(0);
  process.stdout.write(JSON.stringify(receipt));
} catch (error) {
  process.stderr.write(JSON.stringify({ code: error instanceof MemoryError ? error.code : "UNEXPECTED" }));
  process.exitCode = 1;
} finally { store.close(); }
