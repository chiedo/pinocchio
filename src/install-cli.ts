import { parseArgs } from "node:util";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { diagnose } from "./diagnostic.js";
import { createAgent, discardPrevious, install, locations, rollback, setEnabled, start, status, uninstall, withInstallLock } from "./installer.js";
import { main as memory } from "./memory-cli.js";
import { main as semantic } from "./semantic-cli.js";
import { main as bindings } from "./bindings-cli.js";
import { isRecord } from "./identity.js";
import { ToolError } from "./memory-protocol.js";

export async function main(args: string[]) {
  // Administrative subcommands retain their explicit scope/record validation.
  const domain = args.findIndex((arg) => ["memory", "semantic", "bindings"].includes(arg));
  if (domain >= 0) {
    const command = args[domain];
    const forwarded = [...args.slice(0, domain), ...args.slice(domain + 1)];
    return command === "memory" ? memory(forwarded) : command === "semantic" ? semantic(forwarded) : bindings(forwarded);
  }
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    "config-root": { type: "string" }, "preview-platform": { type: "boolean" },
    "host-stopped": { type: "boolean" }, name: { type: "string" }, repository: { type: "string" },
    global: { type: "boolean" }, tools: { type: "string" }, agent: { type: "string" },
  } });
  const command = positionals[0] ?? "";
  const allowed: Record<string, string[]> = {
    install: ["preview-platform"], upgrade: ["preview-platform", "host-stopped"],
    doctor: ["preview-platform"], create: ["name", "repository", "global", "tools"],
    status: [], start: ["agent"], disable: [], enable: [],
    uninstall: ["host-stopped"], rollback: ["host-stopped"], "discard-previous": ["host-stopped"],
  };
  if (positionals.length !== 1 || !allowed[command] ||
      Object.keys(values).some((key) => key !== "config-root" && !allowed[command]?.includes(key))) {
    throw new ToolError("INVALID_ARGUMENTS");
  }
  if (command === "doctor") return diagnose(values["preview-platform"]);
  const paths = await locations(values["config-root"]);
  if (command === "status") return status(paths);
  if (command === "start") return start(paths, values.agent);
  return withInstallLock(paths, async () => {
    switch (command) {
      case "install": case "upgrade":
        return install(paths, command === "upgrade", values["host-stopped"] ?? false, values["preview-platform"] ?? false);
      case "disable": case "enable": return setEnabled(paths, command === "enable");
      case "uninstall": return uninstall(paths, values["host-stopped"] ?? false);
      case "rollback": return rollback(paths, values["host-stopped"] ?? false);
      case "discard-previous": return discardPrevious(paths, values["host-stopped"] ?? false);
      case "create": {
        if (!values.name || !/^[a-z][a-z0-9-]{0,39}$/.test(values.name) ||
            Boolean(values.global) === Boolean(values.repository)) throw new ToolError("EXPLICIT_NAME_AND_SCOPE_REQUIRED");
        const agents = join(paths.root, "agents");
        await mkdir(agents, { recursive: true, mode: 0o700 });
        return createAgent(paths, ["--name", values.name, "--origin-root", agents,
          "--definition", join(agents, `${values.name}.agent.md`),
          ...(values.repository ? ["--repository", values.repository] : ["--global"]),
          ...(values.tools ? ["--tools", values.tools] : [])]);
      }
      default: throw new ToolError("INVALID_ARGUMENTS");
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main(process.argv.slice(2));
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "INSTALL_COMMAND_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "error", code,
      ...(error instanceof ToolError ? error.details : {}) })}\n`);
    process.exitCode = 1;
  }
}
