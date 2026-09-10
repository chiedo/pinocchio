import { z } from "zod";
import { noteSchema, operationIdSchema, recordIdSchema, revisionSchema } from "./memory-types.js";

export const SEARCH_TOOL = "agent_memory_search";
export const SAVE_TOOL = "agent_memory_save";
export const CONTEXT_META = "pinocchio/context-v1";
export const MEMORY_DEADLINE_MS = 1_000;
export const searchSchema = z.object({ query: z.string().trim().min(1).max(500) }).strict();
export const saveSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remember"), operationId: operationIdSchema, note: noteSchema }).strict(),
  z.object({ action: z.literal("correct"), operationId: operationIdSchema, recordId: recordIdSchema,
    expectedRevision: revisionSchema, note: noteSchema }).strict(),
  z.object({ action: z.literal("status"), operationId: operationIdSchema }).strict(),
]);
export const ticketSchema = z.object({
  version: z.literal(1), root: z.string().min(1), recipient: z.string().min(1),
  request: z.string().min(1), call: z.string().min(1), server: z.string().min(1),
  tool: z.enum([SEARCH_TOOL, SAVE_TOOL]), argumentsHash: z.string().length(64),
  deadline: z.number().int(), signature: z.string().length(64),
}).strict();
export type ContextTicket = z.infer<typeof ticketSchema>;
export class ToolError extends Error {
  constructor(readonly code: string, readonly details: { currentRevision?: number } = {}) {
    super(code); this.name = "ToolError";
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new ToolError("INVALID_ARGUMENTS");
  return result;
}
