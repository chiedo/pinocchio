import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { BindingRecord } from "./binding-registry.js";

const text = (max: number) => z.string().min(1).max(max).refine((value) => value.trim().length > 0);
export const operationIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
export const recordIdSchema = z.string().uuid();
export const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const evidenceSchema = z.object({
  kind: z.enum(["user_statement", "tool_observation", "assistant_inference", "manual_entry"]),
  reference: z.object({
    type: z.enum(["url", "file", "text"]),
    value: text(2_048),
  }).strict(),
}).strict();
export const noteSchema = z.object({
  content: text(32_768),
  kind: z.enum(["fact", "decision", "preference", "procedure", "todo", "other"]),
  status: z.enum(["active", "tentative", "superseded"]).default("active"),
  evidence: z.array(evidenceSchema).min(1).max(8),
  sourceAt: z.string().datetime({ offset: true }).optional(),
  confirmedAt: z.string().datetime({ offset: true }).optional(),
}).strict().refine((note) => !note.sourceAt || !note.confirmedAt ||
  Date.parse(note.confirmedAt) >= Date.parse(note.sourceAt));
export type NoteInput = z.input<typeof noteSchema>;
export type Note = z.output<typeof noteSchema>;
export type ValidatedEvidence = z.infer<typeof evidenceSchema> & {
  validation: "syntax_only" | "file_exists_at_save" | "unverified_label";
};
export type MemoryCode =
  | "INVALID_INPUT" | "INVALID_SOURCE" | "SOURCE_UNAVAILABLE"
  | "SCOPE_MISMATCH" | "INSECURE_STORE" | "STORE_REPLACED" | "STORE_BUSY"
  | "STORE_DISABLED" | "STORE_CLOSED" | "STORE_IO_ERROR" | "STORE_CORRUPT"
  | "SCHEMA_UNSUPPORTED" | "SCHEMA_MISMATCH" | "NOT_FOUND" | "RECORD_FORGOTTEN"
  | "REVISION_CONFLICT" | "OPERATION_CONFLICT" | "OPERATION_RETIRED"
  | "CALL_CANCELLED" | "OUTCOME_UNKNOWN" | "ROLLBACK_FAILED";
export class MemoryError extends Error {
  constructor(
    readonly code: MemoryCode,
    readonly details: { operationId?: string; currentRevision?: number } = {},
  ) {
    super(code);
    this.name = "MemoryError";
  }
}
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new MemoryError("INVALID_INPUT");
  return result.data;
}
export function normalizeText(value: string) {
  return value.normalize("NFKC").toLowerCase();
}
export function keywords(value: string) {
  return [...new Set(normalizeText(value).match(/[\p{L}\p{N}_]+/gu) ?? [])];
}
export async function validateEvidence(note: Note, binding: BindingRecord): Promise<ValidatedEvidence[]> {
  return Promise.all(note.evidence.map(async (evidence): Promise<ValidatedEvidence> => {
    const { reference } = evidence;
    if (reference.type === "text") return { ...evidence, validation: "unverified_label" };
    if (reference.type === "url") {
      let url: URL;
      try { url = new URL(reference.value); } catch { throw new MemoryError("INVALID_SOURCE"); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
        throw new MemoryError("INVALID_SOURCE");
      }
      return { ...evidence, validation: "syntax_only" };
    }
    let path: string;
    if (binding.scope.kind === "global") {
      if (!isAbsolute(reference.value)) throw new MemoryError("INVALID_SOURCE");
      path = reference.value;
    } else {
      path = resolve(binding.scope.root, reference.value);
    }
    try { path = await realpath(path); }
    catch { throw new MemoryError("SOURCE_UNAVAILABLE"); }
    if (binding.scope.kind === "repository") {
      const suffix = relative(binding.scope.root, path);
      if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
        throw new MemoryError("INVALID_SOURCE");
      }
    }
    try {
      if (!(await stat(path)).isFile()) throw new MemoryError("INVALID_SOURCE");
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError("SOURCE_UNAVAILABLE");
    }
    return {
      ...evidence, reference: { type: "file", value: path }, validation: "file_exists_at_save",
    };
  }));
}
export interface MemoryReceipt {
  status: "committed";
  operationId: string;
  action: "remember" | "correct" | "forget" | "disable" | "enable";
  recordId: string | null;
  revision: number | null;
  recordedAt: string;
  replayed: boolean;
  recordStatus?: "forgotten";
}
export async function acknowledge(
  receipt: MemoryReceipt,
  deliver: (receipt: MemoryReceipt) => Promise<void>,
): Promise<void> {
  try { await deliver(receipt); }
  catch { throw new MemoryError("OUTCOME_UNKNOWN", { operationId: receipt.operationId }); }
}
