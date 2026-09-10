import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace } from "./workspace.js";
import { registerBinding } from "../../src/binding-registry.js";
import type { DefinitionOrigin } from "../../src/binding-registry.js";

export async function createProductionFixture() {
  const workspace = await createWorkspace();
  const definitions = {
    foreground: { origin: "project", root: join(workspace.repository, ".github", "agents") },
    alpha: { origin: "user", root: join(workspace.config, "agents") },
    beta: { origin: "plugin", root: join(workspace.repository, "synthetic-plugin", "agents") },
  } satisfies Record<string, { origin: DefinitionOrigin; root: string }>;
  for (const definition of Object.values(definitions)) {
    await mkdir(definition.root, { recursive: true });
    await writeFile(join(definition.root, "shared.agent.md"),
      "---\nname: shared\ndescription: Synthetic definition fixture.\n---\nUse only your configured tools.\n");
  }
  async function bind(
    name: keyof typeof definitions,
    scope: { kind: "global" } | { kind: "repository"; root: string } =
      { kind: "repository", root: workspace.repository },
  ) {
    const definition = definitions[name];
    return registerBinding({
      configRoot: workspace.config,
      definitionPath: join(definition.root, "shared.agent.md"),
      origin: definition.origin,
      originRoot: definition.root,
      scope,
    });
  }
  return { ...workspace, definitions, bind };
}
