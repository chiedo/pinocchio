import { z } from "zod";
import type { searchSchema } from "./memory-protocol.js";
import { MemoryError } from "./memory-types.js";

export interface ConversationWindow { since: string; before: string }
type SearchPlan = { mode: "topic"; query: string } | { mode: "recent"; window: ConversationWindow };
const day = 86_400_000;

// Recognize recap questions, not arbitrary queries containing "recent" or a date.
export function recentConversationWindow(query: string, now = Date.now()): ConversationWindow | undefined {
  const recap = /\b(?:discuss(?:ed|ing)?|talk(?:ed|ing)?|chat(?:ted|ting)?|conversation|spoke|say|said)\b/i.test(query);
  const question = /\bwhat\b.*\b(?:we|i|you|user)\b/i.test(query) ||
    /\b(?:recap|summari[sz]e)\b/i.test(query) || /^(?:recent|previous|last)\s+(?:conversation|chat)\b/i.test(query);
  const duration = /\b(?:last|past)\s+(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i.exec(query);
  const previous = /\b(?:just|last|previous|recent|earlier)\b/i.test(query);
  if (!question || !recap || (!duration && !previous)) return;
  const anchor = /\bbefore\s+(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))/i.exec(query);
  if (anchor && !z.string().datetime({ offset: true }).safeParse(anchor[1]).success) throw new MemoryError("INVALID_INPUT");
  const before = anchor ? Date.parse(anchor[1]!) : now;
  const unit = duration?.[2]?.toLowerCase()[0];
  const span = duration ? Number(duration[1]) * (unit === "d" ? day : unit === "h" ? 3_600_000 : 60_000) : 30 * day;
  if (!Number.isFinite(before) || span <= 0 || span > 30 * day) throw new MemoryError("INVALID_INPUT");
  return { since: new Date(before - span).toISOString(), before: new Date(before).toISOString() };
}

export function resolveMemorySearch(args: z.infer<typeof searchSchema>, now = Date.now()): SearchPlan {
  if (args.mode === "recent") {
    const before = args.before ? Date.parse(args.before) : now;
    const since = args.since ? Date.parse(args.since) : before - 30 * day;
    if (since >= before || before - since > 30 * day) throw new MemoryError("INVALID_INPUT");
    return { mode: "recent", window: { since: new Date(since).toISOString(), before: new Date(before).toISOString() } };
  }
  if (!args.query) throw new MemoryError("INVALID_INPUT");
  const window = args.mode === "topic" ? undefined : recentConversationWindow(args.query, now);
  return window ? { mode: "recent", window } : { mode: "topic", query: args.query };
}
