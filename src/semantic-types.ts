import { z } from "zod";
export const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const MODEL_ID = `Xenova/all-MiniLM-L6-v2@${MODEL_REVISION}:q8:mean-l2:256`;
export const DIMENSIONS = 384;
export const MAX_INDEX_RECORDS = 5_000;
export const SEMANTIC_THRESHOLD = 0.45;
export class SemanticError extends Error {
  constructor(readonly code: string) { super(code); this.name = "SemanticError"; }
}
export const configSchema = z.object({
  version: z.literal(1), python: z.string().min(1), modelDirectory: z.string().min(1),
  model: z.literal(MODEL_ID),
}).strict();
export type SemanticConfig = z.infer<typeof configSchema>;
export const indexRecordSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict();
export type IndexRecord = z.infer<typeof indexRecordSchema>;
export type IndexSnapshot = (IndexRecord & { content: string })[];
export const candidateSchema = indexRecordSchema.extend({ score: z.number().finite().min(-1.01).max(1.01) });
export type SemanticCandidate = z.infer<typeof candidateSchema>;
export const manifestSchema = z.object({
  version: z.literal(1), generation: z.string().uuid(), namespace: z.string(),
  scope: z.string(), model: z.literal(MODEL_ID), dimensions: z.literal(DIMENSIONS),
  sourceHash: z.string().length(64), indexHash: z.string().length(64),
  records: z.array(indexRecordSchema).max(MAX_INDEX_RECORDS), createdAt: z.string().datetime(),
}).strict();
export type IndexManifest = z.infer<typeof manifestSchema>;
export type RetrievalState = {
  mode: "hybrid" | "keyword";
  reason?: string;
  maintenance?: string;
  generation?: string;
};
