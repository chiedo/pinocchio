import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { configRootPath, registerBinding } from "./binding-registry.js";
import type { BindingReference } from "./binding-registry.js";
import { enroll, prepareContextExtension, removeEnrollment } from "./enrollment.js";
import { ToolError } from "./memory-protocol.js";
import { isRecord } from "./identity.js";

export async function main(args: string[], beforeEnroll?: (reference: BindingReference) => Promise<void>) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    "config-root": { type: "string" }, binding: { type: "string" }, fingerprint: { type: "string" },
    "allow-shared": { type: "boolean" }, definition: { type: "string" }, "origin-root": { type: "string" },
    repository: { type: "string" }, global: { type: "boolean" }, name: { type: "string" },
    tools: { type: "string" },
  } });
  if (positionals.length !== 1) throw new ToolError("INVALID_ARGUMENTS");
  const allowed: Record<string, string[]> = {
    "prepare-context": ["config-root"],
    enroll: ["config-root", "binding", "fingerprint", "allow-shared"],
    remove: ["config-root", "binding", "fingerprint"],
    create: ["config-root", "definition", "origin-root", "repository", "global", "name", "tools"],
  };
  const commandOptions = allowed[positionals[0] ?? ""];
  if (!commandOptions || Object.keys(values).some((key) => !commandOptions.includes(key))) {
    throw new ToolError("INVALID_ARGUMENTS");
  }
  const configRoot = configRootPath(values["config-root"]);
  if (positionals[0] === "prepare-context") return prepareContextExtension(configRoot);
  if (positionals[0] === "create") {
    if (!values.definition || !values["origin-root"] || !values.name ||
        !/^[a-z][a-z0-9-]{0,39}$/.test(values.name) || Boolean(values.repository) === Boolean(values.global)) {
      throw new ToolError("INVALID_ARGUMENTS");
    }
    const tools = (values.tools ?? "view").split(",");
    if (!tools.length || tools.some((tool) => !/^[a-z][a-z0-9_]*$/.test(tool)) ||
        new Set(tools).size !== tools.length) throw new ToolError("EXPLICIT_TOOL_LIST_REQUIRED");
    const handle = await open(values.definition, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`---\nname: ${values.name}\ndescription: Named agent with scoped memory\ntools: ${JSON.stringify(tools)}\n---\nFollow the user's instructions.\n`);
      await handle.sync();
    } finally { await handle.close(); }
    const reference = await registerBinding({
      configRoot, definitionPath: values.definition, origin: "user", originRoot: values["origin-root"],
      scope: values.repository ? { kind: "repository", root: values.repository } : { kind: "global" },
    });
    await beforeEnroll?.(reference);
    return { ...(await enroll(reference)), reference };
  }
  if (!values.binding || !values.fingerprint) throw new ToolError("INVALID_ARGUMENTS");
  const reference = { configRoot, bindingId: values.binding, fingerprint: values.fingerprint };
  if (positionals[0] === "enroll") return enroll(reference, values["allow-shared"] ?? false);
  if (positionals[0] === "remove") return removeEnrollment(reference);
  throw new ToolError("INVALID_ARGUMENTS");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "error", code: isRecord(error) && typeof error.code === "string" ? error.code : "ENROLLMENT_FAILED" })}\n`);
    process.exitCode = 1;
  }
}
