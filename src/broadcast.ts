import { constants } from "node:fs";
import { open, readdir, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import { fingerprint, hasCode, loadBinding, privateDirectory } from "./binding-registry.js";
import type { BindingReference } from "./binding-registry.js";
import { readPrivateJson, writeAtomic } from "./semantic-files.js";
import { isRecord } from "./identity.js";
import { MANAGED_AGENT_TOOLS } from "./enrollment.js";

export const BROADCAST_HEARTBEAT_MS = 5_000;
export const BROADCAST_LIVE_MS = 30_000;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z.object({
  bindingId: z.string().uuid(), profileHash: hash, settingsHash: hash,
  sharedHash: hash, tools: z.array(z.string()),
}).strict();
export type BroadcastTarget = z.infer<typeof targetSchema>;
const agentResultSchema = z.object({
  bindingId: z.string().uuid(), agent: z.string(),
  status: z.enum(["refreshed", "failed"]), code: z.string().optional(),
}).strict();
const requestSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), createdAt: z.number(),
  runtime: hash, targets: z.array(targetSchema), agents: z.array(agentResultSchema),
}).strict();
export type BroadcastRequest = z.infer<typeof requestSchema>;
const sessionSchema = z.object({
  version: z.literal(1), instance: z.string().uuid(), sessionId: z.string().min(1).max(256),
  bindingId: z.string().uuid(), agent: z.string(), heartbeat: z.number(),
  runtime: hash, settingsHash: hash,
  requestId: z.string().uuid().optional(),
  status: z.enum(["pending", "updated", "restart-required", "failed"]),
  code: z.string().optional(),
  missingTools: z.array(z.string()).optional(),
  unmatchedTools: z.array(z.string()).optional(),
}).strict();
type SessionRecord = z.infer<typeof sessionSchema>;

export function broadcastCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string" ? error.code : "BROADCAST_FAILED";
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
async function directory(root: string) {
  await privateDirectory(join(root, "pinocchio"), false);
  const path = join(root, "pinocchio", "broadcast");
  await privateDirectory(path, true);
  await privateDirectory(join(path, "sessions"), true);
  return path;
}
async function optionalJson(path: string) {
  try { return await readPrivateJson(path); }
  catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
}
async function safeText(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024) fail("BROADCAST_UNSAFE_OR_OVERSIZED_PROFILE");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
export async function broadcastSnapshot(reference: BindingReference) {
  const binding = await loadBinding(reference);
  const profile = await safeText(binding.definition.path);
  if (!profile.includes("<!-- pinocchio-memory:v1 -->")) fail("AGENT_NOT_ENROLLED");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(profile);
  if (!match) fail("INVALID_PROFILE");
  const doc = parseDocument(match[1] ?? "", { uniqueKeys: true });
  if (doc.errors.length) fail("INVALID_PROFILE");
  const settings: unknown = doc.toJS();
  if (!isRecord(settings) || !Array.isArray(settings.tools) ||
      !settings.tools.every((tool): tool is string => typeof tool === "string")) fail("INVALID_PROFILE");
  const shared = await safeText(join(reference.configRoot, "pinocchio", "AGENTS.md"));
  return {
    target: targetSchema.parse({
      bindingId: reference.bindingId, profileHash: fingerprint(profile),
      settingsHash: fingerprint(JSON.stringify(settings)), sharedHash: fingerprint(shared),
      tools: settings.tools,
    }),
    body: profile.slice(match[0].length), shared,
    agent: basename(binding.definition.path, ".agent.md"),
  };
}
export async function broadcastRuntimeVersion() {
  const path = dirname(fileURLToPath(import.meta.url));
  const names = (await readdir(path)).filter((name) => name.endsWith(".js")).sort();
  if (!names.length) fail("BROADCAST_BUILD_REQUIRED");
  const files = await Promise.all(names.map(async (name) => [name, fingerprint(await readFile(join(path, name), "utf8"))]));
  const dependencies = fingerprint(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
  // The extension host and the publisher intentionally run under different Node versions.
  return fingerprint(JSON.stringify({ files, dependencies }));
}
export async function latestBroadcast(root: string) {
  const value = await optionalJson(join(await directory(root), "latest.json"));
  return value === undefined ? undefined : requestSchema.parse(value);
}
export async function publishBroadcast(root: string, request: BroadcastRequest) {
  await writeAtomic(join(await directory(root), "latest.json"), requestSchema.parse(request));
}
export async function withBroadcastLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const path = join(await directory(root), "upgrade.lock");
  let lock;
  try { lock = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (hasCode(error, "EEXIST")) fail("BROADCAST_BUSY"); throw error; }
  try { return await run(); }
  finally { await lock.close(); await unlink(path); }
}
export async function broadcastStatus(root: string, now = Date.now()) {
  const request = await latestBroadcast(root);
  const path = join(await directory(root), "sessions");
  const sessions: SessionRecord[] = [];
  for (const name of (await readdir(path)).sort()) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const value = await optionalJson(join(path, name));
    if (value === undefined) continue;
    const record = sessionSchema.parse(value);
    if (record.heartbeat > now || now - record.heartbeat > BROADCAST_LIVE_MS) continue;
    const agent = request?.agents.find((item) => item.bindingId === record.bindingId);
    const { code: _code, missingTools: _missingTools, unmatchedTools: _unmatchedTools, ...rest } = record;
    if (request && agent?.status === "failed") {
      sessions.push({ ...rest, requestId: request.id, status: "failed", code: agent.code ?? "BROADCAST_REFRESH_FAILED" });
    } else if (request && request.targets.some((target) => target.bindingId === record.bindingId) && record.requestId !== request.id) {
      sessions.push({ ...rest, requestId: request.id, status: "pending" });
    } else sessions.push(record);
  }
  return {
    broadcast: request?.id ?? null, agents: request?.agents ?? [], sessions,
    coverage: "Only live listeners in this configuration root are discoverable. Older sessions and existing delegated helpers require a one-time restart; other machines and cloud jobs are excluded.",
  };
}

export class BroadcastListener {
  private record: SessionRecord | undefined;
  private delivery: { request: BroadcastRequest; target: BroadcastTarget } | undefined;
  private instance = randomUUID();
  constructor(private readonly root: string, private readonly sessionId: string, private readonly runtime: string) {}

  private async save() {
    if (!this.record) return;
    await writeAtomic(join(await directory(this.root), "sessions", `${this.instance}.json`), sessionSchema.parse(this.record));
  }
  async heartbeat(reference: BindingReference, now = Date.now()) {
    if (reference.configRoot !== this.root) fail("BROADCAST_SCOPE_MISMATCH");
    if (!this.record || this.record.bindingId !== reference.bindingId) {
      const snapshot = await broadcastSnapshot(reference);
      this.delivery = undefined;
      this.record = {
        version: 1, instance: this.instance, sessionId: this.sessionId,
        bindingId: reference.bindingId, agent: snapshot.agent, heartbeat: now,
        runtime: this.runtime, settingsHash: snapshot.target.settingsHash, status: "pending",
      };
    } else {
      await loadBinding(reference);
      this.record.heartbeat = now;
    }
    await this.save();
  }
  async prepare(reference: BindingReference, offeredTools: string[]) {
    await this.heartbeat(reference);
    const request = await latestBroadcast(this.root);
    const target = request?.targets.find((item) => item.bindingId === reference.bindingId);
    if (!request || !target || !this.record) return;
    if (this.record.requestId === request.id && this.record.status !== "pending" &&
        this.record.code !== "TOOLS_NOT_AVAILABLE") return;
    this.delivery = undefined;
    this.record.requestId = request.id;
    delete this.record.code;
    delete this.record.missingTools;
    delete this.record.unmatchedTools;
    const reason = request.runtime !== this.runtime ? "RUNTIME_CHANGED"
      : target.settingsHash !== this.record.settingsHash ? "AGENT_SETTINGS_CHANGED" : undefined;
    if (reason) {
      this.record.status = "restart-required"; this.record.code = reason;
      await this.save();
      return;
    }
    const offered = new Set(offeredTools);
    const required = new Set<string>(MANAGED_AGENT_TOOLS);
    const missingTools = MANAGED_AGENT_TOOLS.filter((tool) => !offered.has(tool));
    // Profile tools are an allowlist, not dependencies: hosts ignore unknown/product-specific names.
    const unmatchedTools = target.tools.filter((tool) => !required.has(tool) && !offered.has(tool));
    if (unmatchedTools.length) this.record.unmatchedTools = unmatchedTools;
    if (missingTools.length) {
      this.record.status = "failed"; this.record.code = "TOOLS_NOT_AVAILABLE";
      this.record.missingTools = missingTools;
      await this.save();
      return;
    }
    const snapshot = await broadcastSnapshot(reference);
    if (JSON.stringify(snapshot.target) !== JSON.stringify(target)) fail("BROADCAST_TARGET_CHANGED");
    const prompt = [
      snapshot.body,
      "## Shared Pinocchio instructions",
      "These supplement your role and repository rules; higher-priority instructions still take precedence.",
      "This refresh does not authorize remote actions, change permissions, or update cloud jobs.",
      snapshot.shared,
      "Continue the user's actual request normally. Do not announce or acknowledge this background instruction refresh, or save it to memory.",
    ].join("\n\n");
    this.record.status = "pending";
    this.delivery = { request, target };
    await this.save();
    return prompt;
  }
  async acknowledge(reference: BindingReference) {
    const delivery = this.delivery;
    if (!delivery || !this.record || this.record.bindingId !== reference.bindingId) fail("BROADCAST_NO_DELIVERY");
    const snapshot = await broadcastSnapshot(reference);
    if (JSON.stringify(snapshot.target) !== JSON.stringify(delivery.target)) fail("BROADCAST_TARGET_CHANGED");
    this.record.status = "updated";
    this.record.heartbeat = Date.now();
    this.delivery = undefined;
    await this.save();
  }
  issue() {
    const record = this.record;
    if (!record || !["failed", "restart-required"].includes(record.status)) return;
    return {
      key: `${record.bindingId}:${record.requestId ?? ""}:${record.code ?? ""}`,
      code: record.code ?? "BROADCAST_FAILED",
      restartRequired: record.status === "restart-required",
    };
  }
  async failed(error: unknown) {
    if (!this.record) return;
    this.delivery = undefined;
    this.record.status = "failed"; this.record.code = broadcastCode(error);
    await this.save();
  }
  async close() {
    this.record = undefined; this.delivery = undefined;
    const path = join(await directory(this.root), "sessions", `${this.instance}.json`);
    try { await unlink(path); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  }
}
