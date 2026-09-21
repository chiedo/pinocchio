import { parseArgs } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  BindingError, configRootPath, registerBinding, revokeBinding,
} from "./binding-registry.js";
import type { BindingReference, DefinitionOrigin } from "./binding-registry.js";
import { BoundIdentityAdapter } from "./bound-identity.js";
import { createBoundMcpServer, BOUND_IDENTITY_TOOL } from "./bound-mcp.js";
import { cliInvocation, writeCliError, writeCliResult } from "./cli-output.js";

export function bindingLaunch(reference: BindingReference) {
  return {
    type: "local" as const,
    command: process.execPath,
    args: [
      fileURLToPath(import.meta.url), "serve",
      "--config-root", reference.configRoot,
      "--binding", reference.bindingId,
      "--fingerprint", reference.fingerprint,
    ],
    tools: [BOUND_IDENTITY_TOOL],
  };
}
export async function main(args: string[]) {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: {
      "config-root": { type: "string" },
      definition: { type: "string" },
      origin: { type: "string" },
      "origin-root": { type: "string" },
      repository: { type: "string" },
      global: { type: "boolean" },
      binding: { type: "string" },
      fingerprint: { type: "string" },
    },
  });
  if (positionals.length !== 1) throw new BindingError("INVALID_BINDING");
  const command = positionals[0];
  const allowed = command === "bind"
    ? ["config-root", "definition", "origin", "origin-root", "repository", "global"]
    : ["config-root", "binding", "fingerprint"];
  if (Object.keys(values).some((key) => !allowed.includes(key))) {
    throw new BindingError("INVALID_BINDING");
  }
  if (command === "bind") {
    if (!values.definition || !values["origin-root"] ||
        !["project", "user", "plugin"].includes(values.origin ?? "") ||
        Boolean(values.repository) === Boolean(values.global)) {
      throw new BindingError("INVALID_BINDING");
    }
    const reference = await registerBinding({
      ...(values["config-root"] ? { configRoot: values["config-root"] } : {}),
      definitionPath: values.definition,
      originRoot: values["origin-root"],
      origin: values.origin as DefinitionOrigin,
      scope: values.repository ? { kind: "repository", root: values.repository } : { kind: "global" },
    });
    return { status: "registered", reference, mcpServer: bindingLaunch(reference) };
  }
  const reference: BindingReference = {
    configRoot: configRootPath(values["config-root"]),
    bindingId: values.binding ?? "",
    fingerprint: values.fingerprint ?? "",
  };
  if (command === "serve") {
    await createBoundMcpServer(reference).connect(new StdioServerTransport());
    return undefined;
  }
  if (command === "status") return new BoundIdentityAdapter(reference).resolve();
  if (command === "revoke") {
    await revokeBinding(reference);
    return { status: "revoked" };
  }
  throw new BindingError("INVALID_BINDING");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const invocation = cliInvocation(process.argv.slice(2));
  try {
    const result = await main(invocation.args);
    if (result !== undefined) {
      await writeCliResult(result, invocation.json);
      if (result.status === "unavailable") process.exitCode = 1;
    }
  } catch (error) {
    const code = error instanceof BindingError ? error.code : "REGISTRY_IO_ERROR";
    writeCliError({ code }, invocation.json);
    process.exitCode = 1;
  }
}
