import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { canonicalRepository, configRootPath, hasCode, loadBinding, privateDirectory } from "./binding-registry.js";
import { main as create } from "./enrollment-cli.js";
import { enroll, refreshEnrollment, removeEnrollment } from "./enrollment.js";
import { isRecord } from "./identity.js";
import { ToolError } from "./memory-protocol.js";
import { readPrivateJson, writeAtomic } from "./semantic-files.js";
import { setConversationEnabled } from "./conversation-memory.js";
import { setupRetrieval } from "./semantic-setup.js";
import type { RetrievalMode } from "./semantic-files.js";

const referenceSchema = z.object({
  configRoot: z.string(), bindingId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function setup(options: {
  configRoot?: string; name: string; repository?: string; global?: boolean; remove?: boolean; tools?: string;
  conversation?: boolean; retrieval?: RetrievalMode; python?: string;
}) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(options.name) || (options.global && options.repository) ||
      ((options.remove || options.conversation !== undefined) && (options.retrieval || options.python)) ||
      (options.retrieval === "keyword" && options.python)) {
    throw new ToolError("INVALID_ARGUMENTS");
  }
  const root = configRootPath(options.configRoot);
  const repository = options.remove || options.global || options.conversation !== undefined
    ? undefined : await canonicalRepository(options.repository ?? process.cwd());
  await mkdir(root, { recursive: true, mode: 0o700 });
  await privateDirectory(join(root, "pinocchio"), true);
  const directory = join(root, "pinocchio", "setup");
  await privateDirectory(directory, true);
  const receipt = join(directory, `${options.name}.json`);
  const lockPath = join(directory, `${options.name}.lock`);
  let lock;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (hasCode(error, "EEXIST")) throw new ToolError("SETUP_BUSY"); throw error; }
  try {
    let reference: z.infer<typeof referenceSchema> | undefined;
    try { reference = referenceSchema.parse(await readPrivateJson(receipt)); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    if (reference) {
      if (reference.configRoot !== root) throw new ToolError("SETUP_SCOPE_MISMATCH");
      const binding = await loadBinding(reference);
      if (binding.definition.path !== join(root, "agents", `${options.name}.agent.md`)) {
        throw new ToolError("SETUP_SCOPE_MISMATCH");
      }
      if (options.conversation !== undefined) {
        await setConversationEnabled(reference, options.conversation);
        return { status: options.conversation ? "conversation-enabled" : "conversation-paused", restartRequired: false };
      }
      if (!options.remove && (binding.scope.kind !== (options.global ? "global" : "repository") ||
          (binding.scope.kind === "repository" && binding.scope.root !== repository))) {
        throw new ToolError("SETUP_SCOPE_MISMATCH");
      }
      const text = await readFile(binding.definition.path, "utf8");
      const enrolled = text.includes("<!-- pinocchio-memory:v1 -->");
      if (options.remove) {
        if (enrolled) await removeEnrollment(reference);
        return { status: "removed", profilePreserved: true, memoriesPreserved: true, restartRequired: true };
      }
      if (!enrolled) await enroll(reference);
      else await refreshEnrollment(reference);
      return { status: "ready", agent: options.name, profile: binding.definition.path,
        sharedInstructions: join(root, "pinocchio", "AGENTS.md"), reference, restartRequired: true,
        retrieval: await setupRetrieval(reference, { mode: options.retrieval, python: options.python }) };
    }
    if (options.remove || options.conversation !== undefined) throw new ToolError("AGENT_NOT_INSTALLED");
    const agents = join(root, "agents");
    await mkdir(agents, { recursive: true, mode: 0o700 });
    const result = await create(["create", "--config-root", root, "--name", options.name,
      "--origin-root", agents, "--definition", join(agents, `${options.name}.agent.md`),
      ...(repository ? ["--repository", repository] : ["--global"]),
      "--tools", options.tools ?? "view,rg,glob,bash,apply_patch,task"],
    async (ref) => { await writeAtomic(receipt, ref); });
    if (!("reference" in result)) throw new ToolError("SETUP_REFERENCE_MISSING");
    return { ...result, status: "ready", agent: options.name, restartRequired: true,
      retrieval: await setupRetrieval(result.reference, { mode: options.retrieval, python: options.python }) };
  } finally { await lock.close(); await unlink(lockPath); }
}

export async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    "config-root": { type: "string" }, name: { type: "string", default: "pinocchio" },
    repository: { type: "string" }, global: { type: "boolean" }, remove: { type: "boolean" },
    tools: { type: "string" },
    "pause-conversation": { type: "boolean" }, "resume-conversation": { type: "boolean" },
    "keyword-only": { type: "boolean" }, hybrid: { type: "boolean" }, python: { type: "string" },
  } });
  const control = values["pause-conversation"] || values["resume-conversation"];
  if (positionals.length || (values["pause-conversation"] && values["resume-conversation"]) ||
      (values["keyword-only"] && values.hybrid) ||
      (control && (values.remove || values.repository || values.global || values.tools)) ||
      (values.remove && (values.repository || values.global || values.tools))) {
    throw new ToolError("INVALID_ARGUMENTS");
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || (minor ?? 0) < 18) throw new ToolError("NODE_22_18_OR_NEWER_22_REQUIRED");
  let host;
  try { host = await promisify(execFile)("copilot", ["--version"], { timeout: 15_000, maxBuffer: 16_384 }); }
  catch { throw new ToolError("COPILOT_NOT_AVAILABLE"); }
  const result = await setup({
    name: values.name,
    ...(values["config-root"] ? { configRoot: values["config-root"] } : {}),
    ...(values.repository ? { repository: values.repository } : {}),
    ...(values.global ? { global: true } : {}),
    ...(values.remove ? { remove: true } : {}),
    ...(values.tools ? { tools: values.tools } : {}),
    ...(control ? { conversation: !values["pause-conversation"] } : {}),
    ...(values["keyword-only"] ? { retrieval: "keyword" as const } : values.hybrid ? { retrieval: "hybrid" as const } : {}),
    ...(values.python ? { python: values.python } : {}),
  });
  return { ...result, host: host.stdout.trim().split("\n")[0], compatibility: "preview",
    next: control ? "Conversation capture and automatic recall settings apply immediately; explicit memory tools remain available."
      : values.remove ? "Restart Copilot to unload the agent's memory tools." : `Restart Copilot, then select /agent ${values.name}. Or run: copilot --agent ${values.name}`,
    runtime: "This checkout supplies the runtime. Keep it and its node_modules in place." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "SETUP_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "error", code,
      repair: "Setup is incomplete. Resolve the reported error and rerun with the same agent and scope. Use --python /absolute/path/to/prepared/python for a custom runtime, or --keyword-only to explicitly opt out.",
      ...(error instanceof ToolError ? error.details : {}) })}\n`);
    process.exitCode = 1;
  }
}
