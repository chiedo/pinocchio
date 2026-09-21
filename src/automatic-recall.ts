import { keywords } from "./memory-types.js";
import { SEMANTIC_THRESHOLD } from "./semantic-types.js";
import type { SemanticCandidate } from "./semantic-types.js";

const genericWords = new Set(("a an and are as at be been did do does for from had has have how i in is it its me my of on or our that the this to was we were what when which who with you your about " +
  "can could would should please help work working make give get tell suggest suggestions improve improving better more things something anything need want know confirm available " +
  "yes no ok okay thanks thank great previous user assistant message redacted credential token email number").split(" "));

export function automaticRecallTerms(text: string) {
  return keywords(text.replace(/^\[(?:user|assistant) [^\]]+\]\s*/, ""))
    .filter((term) => !genericWords.has(term));
}

export function isRecallFollowup(prompt: string) {
  return automaticRecallTerms(prompt).length <= 1 &&
    /\b(?:it|this|that|those|them|these|more|better|suggestions|improv(?:e|ing)|why|what about)\b/i.test(prompt);
}

export function automaticRecallQuery(prompt: string, previousPrompts: readonly string[] = []) {
  const terms = automaticRecallTerms(prompt);
  const context = isRecallFollowup(prompt) ? previousPrompts.slice(-2).flatMap(automaticRecallTerms) : [];
  const combined = [...new Set([...context, ...terms])].slice(0, 12);
  return combined.length ? combined.join(" ").slice(0, 500) : undefined;
}

interface RecallRecord {
  id: string; revision: number; content: string;
  source_at: string | null; confirmed_at: string | null; recorded_at: string;
}

export function rankAutomaticRecall<T extends RecallRecord>(
  query: string, records: T[], candidates: SemanticCandidate[],
): T[] {
  const terms = automaticRecallTerms(query);
  if (!terms.length) return [];
  const semantic = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return records.flatMap((record) => {
    const words = new Set(automaticRecallTerms(record.content));
    const hits = terms.filter((term) => words.has(term)).length;
    const candidate = semantic.get(record.id);
    const similarity = candidate?.revision === record.revision && candidate.score >= SEMANTIC_THRESHOLD
      ? candidate.score : 0;
    if (hits < Math.min(2, terms.length) && !similarity) return [];
    return [{ record, relevance: Math.max(hits / terms.length, similarity),
      date: Date.parse(record.confirmed_at ?? record.source_at ?? record.recorded_at) }];
  }).sort((a, b) => b.relevance - a.relevance || b.date - a.date || a.record.id.localeCompare(b.record.id))
    .map(({ record }) => record);
}
