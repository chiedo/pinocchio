import { normalizeText } from "./memory-types.js";
import { SEMANTIC_THRESHOLD } from "./semantic-types.js";
import type { SemanticCandidate } from "./semantic-types.js";

interface RankedRecord {
  id: string; revision: number; content: string; source_at: string | null; confirmed_at: string | null;
}
export function fuseRanks<T extends RankedRecord>(
  query: string, lexical: T[], semanticRows: T[], candidates: SemanticCandidate[], now = Date.now(),
): T[] {
  const live = new Map([...lexical, ...semanticRows].map((row) => [row.id, row]));
  const semantic = candidates.filter((item) =>
    item.score >= SEMANTIC_THRESHOLD && live.get(item.id)?.revision === item.revision,
  ).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const literal = lexical.filter((row) => normalizeText(row.content).includes(normalizeText(query)));
  const scores = new Map<string, number>();
  for (const [items, weight] of [[lexical, 1], [semantic, 1], [literal, 2]] as const) {
    items.forEach((item, rank) => scores.set(item.id, (scores.get(item.id) ?? 0) + weight / (60 + rank + 1)));
  }
  const ranked = [...scores].map(([id, score]) => {
    const row = live.get(id)!;
    const source = row.confirmed_at ?? row.source_at;
    const age = source ? Math.max(0, now - Date.parse(source)) / 86_400_000 : Infinity;
    return { row, score: score * (1 + 0.1 * Math.pow(0.5, age / 30)) };
  });
  return ranked.sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id)).map((item) => item.row);
}
