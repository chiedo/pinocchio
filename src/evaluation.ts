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
export function corpus(role: Role, size: number) {
  return Array.from({ length: size }, (_, index) => index < projects.length
    ? `Project ${projects[index]} approved release marker: ${marker(role, index)}.`
    : `Inventory record INV-${index}: synthetic warehouse bin number ${index}.`);
}
export async function acceptance() {
  const config = acceptanceSchema.parse(JSON.parse(await readFile(new URL("../../evaluations/v1.json", import.meta.url), "utf8")));
  const frozen = { config, corpus: roles.map((role) => corpus(role, config.corpusPerNamespace)),
    recallPrompts: projects.map((_, index) => recallPrompt(index)),
    savePrompts: roles.flatMap((role) => projects.map((_, index) => savePrompt(role, index))) };
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
