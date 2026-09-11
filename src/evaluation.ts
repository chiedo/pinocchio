import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const positive = z.number().finite().positive();
const count = positive.int();
export const acceptanceSchema = z.object({
  version: z.literal(1),
  host: z.object({ cli: z.string(), sdk: z.string(), node: z.string(), platform: z.literal("linux"), arch: z.literal("x64") }).strict(),
  model: z.string().min(1), effort: z.literal("medium"), retrieval: z.literal("hybrid"),
  corpusPerNamespace: count.min(8), backendSamples: count.min(100), longSessionRequests: count.min(128),
  recallSamplesPerRole: z.literal(4), saveSamplesPerRole: z.literal(4), unknownSamplesPerRole: z.literal(1),
  followupSamplesPerRole: z.literal(1),
  thresholds: z.object({
    backendP95Ms: positive, searchCompliance: positive.max(1), scopedRetrieval: positive.max(1),
    saveQuality: positive.max(1), answerBenefit: positive.max(1), scopeLeaks: z.literal(0), unknownAnswers: z.literal(1),
  }).strict(),
  limits: z.object({
    modelCalls: count, callsPerTrial: count, inputTokens: count, outputTokens: count,
    nanoAiu: count, trialMs: count, runMs: count,
  }).strict(),
}).strict();
export type Acceptance = z.infer<typeof acceptanceSchema>;
export const roles = ["foreground", "helper"] as const;
export type Role = typeof roles[number];
export const releaseFaults = ["worker-failures", "missing-identity", "duplicate-save", "lost-save-ack",
  "concurrent-correction-deletion", "interrupted-index-publication", "lock-failure", "long-session-compaction", "backend-latency"];
export const projects = ["Lumen", "Cinder", "Orchid", "Tundra"] as const;
export function marker(role: Role, index: number) {
  return `${role === "foreground" ? "LARCH" : "CORAL"}-${704 + index * 137}`;
}
export function recallPrompt(index: number) {
  return `What is the approved release marker for Project ${projects[index]}? Answer with the marker if supported, otherwise UNKNOWN.`;
}
export function saveMarker(role: Role, index: number) {
  return `${role === "foreground" ? "WILLOW" : "PEBBLE"}-${931 + index * 113}`;
}
export function savePrompt(role: Role, index: number) {
  return `For future reference: the approved release marker for Project Archive${index} is ${saveMarker(role, index)}. This is a confirmed project decision; retain this fact for future sessions.`;
}
export const followupPrompts = ["We are discussing Project Lumen. Acknowledge only.",
  "What is its approved release marker? Answer with the marker if supported, otherwise UNKNOWN."];
export function corpus(role: Role, size: number) {
  return Array.from({ length: size }, (_, index) => index < projects.length
    ? `Project ${projects[index]} approved release marker: ${marker(role, index)}.`
    : `Inventory record INV-${index}: synthetic warehouse bin number ${index}.`);
}
export async function acceptance() {
  const config = acceptanceSchema.parse(JSON.parse(await readFile(new URL("../../evaluations/v1.json", import.meta.url), "utf8")));
  const frozen = { config, corpus: roles.map((role) => corpus(role, config.corpusPerNamespace)),
    recallPrompts: projects.map((_, index) => recallPrompt(index)),
    savePrompts: roles.flatMap((role) => projects.map((_, index) => savePrompt(role, index))), followupPrompts };
  return { config, hash: createHash("sha256").update(JSON.stringify(frozen)).digest("hex") };
}
export function distribution(samples: number[]) {
  if (samples.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("INVALID_LATENCY_SAMPLE");
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
  return { count: sorted.length, p50: quantile(0.5), p95: quantile(0.95) };
}
export class LiveBudget {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  nanoAiu = 0;
  missingUsage = 0;
  #seen = new Set<string>();
  constructor(readonly limits: Acceptance["limits"]) {}
  record(id: string, usage: { inputTokens?: number; outputTokens?: number; nanoAiu?: number }) {
    if (this.#seen.has(id)) return;
    this.#seen.add(id);
    this.calls++;
    for (const key of ["inputTokens", "outputTokens", "nanoAiu"] as const) {
      const value = usage[key];
      if (value === undefined || !Number.isFinite(value) || value < 0) this.missingUsage++;
      else this[key] += value;
    }
  }
  exhausted() {
    return this.calls >= this.limits.modelCalls || this.inputTokens >= this.limits.inputTokens ||
      this.outputTokens >= this.limits.outputTokens || this.nanoAiu >= this.limits.nanoAiu;
  }
  admit() {
    if (this.exhausted() || this.missingUsage || this.calls + this.limits.callsPerTrial > this.limits.modelCalls) {
      throw new Error("LIVE_BUDGET_OR_USAGE_UNAVAILABLE");
    }
  }
  summary() {
    return { calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens,
      nanoAiu: this.nanoAiu, missingUsage: this.missingUsage, exhausted: this.exhausted() };
  }
}

const nonnegative = z.number().finite().nonnegative();
const latency = z.object({ count: nonnegative.int(), p50: nonnegative.nullable(), p95: nonnegative.nullable() });
const roleResult = z.object({
  role: z.enum(roles), recall: nonnegative.int(), baseline: nonnegative.int(), searched: nonnegative.int(),
  retrieved: nonnegative.int(), saved: nonnegative.int(), unknown: nonnegative.int(), leaks: nonnegative.int(),
  recallSamples: nonnegative.int(), baselineSamples: nonnegative.int(), saveSamples: nonnegative.int(),
  failures: nonnegative.int(), followup: nonnegative.int(), attempted: nonnegative.int(), completed: nonnegative.int(),
});
export function releaseVerdict(contract: { config: Acceptance; hash: string }, commit: string,
  reliability: unknown, live: unknown, workflow: unknown) {
  const result = { version: 1, contractHash: contract.hash, commit, status: "unvalidated", failures: [] as string[] };
  if (reliability === undefined || live === undefined || workflow === undefined) {
    result.failures.push("MISSING_EVALUATION_INPUT"); return result;
  }
  const synthetic = z.object({
    status: z.literal("pass"), contractHash: z.literal(contract.hash), commit: z.literal(commit),
    host: acceptanceSchema.shape.host, corpusPerNamespace: count,
    cases: z.array(z.string()), backendMs: latency,
    longSession: z.object({ requests: count, charged: nonnegative, exhausted: count, misses: count }),
  }).safeParse(reliability);
  const measured = z.object({
    status: z.literal("pass"), contractHash: z.literal(contract.hash), commit: z.literal(commit),
    model: z.literal(contract.config.model), effort: z.literal(contract.config.effort),
    roles: z.array(roleResult).length(2),
    usage: z.object({ calls: count, inputTokens: nonnegative, outputTokens: nonnegative,
      nanoAiu: nonnegative, missingUsage: z.literal(0), exhausted: z.literal(false) }),
    failures: z.array(z.string()).length(0),
    roleLatency: z.array(z.object({ role: z.enum(roles), trialMs: latency, modelMs: latency, toolMs: latency })).length(2),
    omissions: z.array(z.object({ role: z.enum(roles), trials: z.literal(0) })).length(2),
  }).safeParse(live);
  const host = z.object({ passed: z.literal(true), contractHash: z.literal(contract.hash),
    commit: z.literal(commit), cases: z.array(z.string()) }).safeParse(workflow);
  result.status = "fail";
  if (!synthetic.success) result.failures.push("INVALID_SYNTHETIC_EVIDENCE");
  if (!measured.success) result.failures.push("INVALID_LIVE_EVIDENCE");
  if (!host.success || !host.data.cases.includes("native-compaction-preserves-accounting")) result.failures.push("NATIVE_COMPACTION_UNVALIDATED");
  const { config } = contract;
  if (synthetic.success) {
    const s = synthetic.data;
    if (JSON.stringify(s.host) !== JSON.stringify(config.host) || s.corpusPerNamespace !== config.corpusPerNamespace ||
        !releaseFaults.every((name) => s.cases.includes(name)) || s.backendMs.count !== config.backendSamples ||
        s.backendMs.p95 === null || s.backendMs.p95 >= config.thresholds.backendP95Ms ||
        s.longSession.requests !== config.longSessionRequests || s.longSession.charged > 6_000) result.failures.push("SYNTHETIC_GATE_FAILED");
  }
  if (measured.success) {
    const m = measured.data, n = config.recallSamplesPerRole;
    const trials = n * 2 + config.saveSamplesPerRole + config.unknownSamplesPerRole + config.followupSamplesPerRole;
    for (const role of roles) {
      const rows = m.roles.filter((row) => row.role === role), r = rows[0];
      const timings = m.roleLatency.filter((row) => row.role === role), timing = timings[0];
      if (rows.length !== 1 || !r || r.recallSamples !== n || r.baselineSamples !== n ||
          r.saveSamples !== config.saveSamplesPerRole || r.failures || r.completed !== trials || r.attempted !== trials ||
          r.recall > n || r.baseline > n || r.searched > n || r.retrieved > n || r.saved > config.saveSamplesPerRole ||
          r.searched / n < config.thresholds.searchCompliance || r.retrieved / n < config.thresholds.scopedRetrieval ||
          (r.recall - r.baseline) / n < config.thresholds.answerBenefit || r.saved / config.saveSamplesPerRole < config.thresholds.saveQuality ||
          r.leaks || r.unknown !== config.unknownSamplesPerRole || r.followup !== config.followupSamplesPerRole ||
          timings.length !== 1 || !timing || timing.trialMs.count !== trials || timing.modelMs.count < trials ||
          !timing.toolMs.count || [timing.trialMs, timing.modelMs, timing.toolMs].some((item) => item.p50 === null || item.p95 === null) ||
          m.omissions.filter((row) => row.role === role).length !== 1) result.failures.push(`LIVE_${role.toUpperCase()}_GATE_FAILED`);
    }
    if (m.usage.calls >= config.limits.modelCalls || m.usage.inputTokens >= config.limits.inputTokens ||
        m.usage.outputTokens >= config.limits.outputTokens || m.usage.nanoAiu >= config.limits.nanoAiu) result.failures.push("LIVE_LIMIT_EXCEEDED");
  }
  if (!result.failures.length) result.status = "pass";
  return result;
}
