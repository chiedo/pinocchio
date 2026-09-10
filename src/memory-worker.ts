import { parentPort } from "node:worker_threads";
import { z } from "zod";
import { BindingError, loadBinding } from "./binding-registry.js";
import { ContextLedger } from "./context-ledger.js";
import { MemoryStore } from "./memory-store.js";
import { MemoryError, validate } from "./memory-types.js";
import { SAVE_TOOL, SEARCH_TOOL, saveSchema, searchSchema, ToolError } from "./memory-protocol.js";

const referenceSchema = z.object({
  configRoot: z.string(), bindingId: z.string(), fingerprint: z.string(),
}).strict();
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("health"), configRoot: z.string() }).strict(),
  z.object({ action: z.literal("start"), configRoot: z.string(), root: z.string(), recipient: z.string(), stamp: z.string() }).strict(),
  z.object({ action: z.literal("invalidate"), configRoot: z.string(), root: z.string() }).strict(),
  z.object({ action: z.literal("ticket"), configRoot: z.string(), root: z.string(), recipient: z.string(),
    call: z.string(), server: z.string(), tool: z.string(), arguments: z.unknown(), deadline: z.number() }).strict(),
  z.object({ action: z.literal("tool"), reference: referenceSchema, server: z.string(),
    tool: z.enum([SEARCH_TOOL, SAVE_TOOL]), arguments: z.unknown(), ticket: z.unknown() }).strict(),
]);

async function execute(raw: unknown): Promise<unknown> {
  const command = validate(commandSchema, raw);
  if (command.action === "tool") await loadBinding(command.reference);
  const ledger = await ContextLedger.open(command.action === "tool" ? command.reference.configRoot : command.configRoot);
  try {
    if (command.action === "health") return { status: "ready", protocol: 1 };
    if (command.action === "start") return ledger.start(command.root, command.recipient, command.stamp);
    if (command.action === "invalidate") return ledger.invalidate(command.root);
    if (command.action === "ticket") return ledger.issue(command);
    const ticket = ledger.verify(command.ticket, command.server, command.tool, command.arguments);
    const binding = await loadBinding(command.reference);
    const store = await MemoryStore.open(command.reference, { namespace: binding.namespace, scope: binding.scope.kind });
    try {
      if (command.tool === SAVE_TOOL) {
        const args = validate(saveSchema, command.arguments);
        const result = args.action === "status" ? await store.operationStatus(args.operationId)
          : args.action === "remember" ? await store.remember(args.note, args.operationId)
          : await store.correct(args.recordId, args.expectedRevision, args.note, args.operationId);
        ledger.current(ticket);
        return result;
      }
      const args = validate(searchSchema, command.arguments);
      ledger.db.exec("BEGIN IMMEDIATE");
      try {
        ledger.current(ticket);
        const session = ledger.db.prepare("SELECT used,generation FROM sessions WHERE root=?").get(ticket.root);
        const request = ledger.db.prepare("SELECT used FROM requests WHERE root=? AND recipient=? AND request=?")
          .get(ticket.root, ticket.recipient, ticket.request);
        if (typeof session?.used !== "number" || typeof session.generation !== "number" || typeof request?.used !== "number") {
          throw new ToolError("INVALID_ACCOUNTING_STATE");
        }
        const sessionUsed = session.used, requestUsed = request.used, generation = session.generation;
        const available = Math.min(800, 800 - request.used, 6_000 - session.used);
        if (available <= 2) { ledger.db.exec("COMMIT"); return { status: "budget_exhausted", snippets: [] }; }
        return await store.searchSnapshot(args.query, { limit: 100 }, async (matches) => {
        const snippets: { recordId: string; revision: number; content: string; kind: string;
          evidenceKinds: string[]; sourceAt: string | null; confirmedAt: string | null; recordedAt: string }[] = [];
        let duplicate = false;
        let spent = 2;
        for (const item of matches.items) {
          const keys = [ticket.root, ticket.recipient, ticket.request, generation,
            binding.namespace, binding.scope.key, item.id, item.revision];
          if (ledger.db.prepare(`SELECT 1 FROM deliveries WHERE root=? AND recipient=? AND request=?
            AND generation=? AND namespace=? AND scope=? AND record=? AND revision=?`).get(...keys)) {
            duplicate = true; continue;
          }
          const evidence = z.array(z.object({ kind: z.string() })).safeParse(item.evidence);
          if (!evidence.success) throw new ToolError("INVALID_EVIDENCE");
          const snippet = {
            recordId: item.id, revision: item.revision, content: "", kind: item.kind,
            evidenceKinds: [...new Set(evidence.data.map((source) => source.kind))],
            sourceAt: item.source_at, confirmedAt: item.confirmed_at, recordedAt: item.recorded_at,
          };
          const base = Buffer.byteLength(JSON.stringify(snippet)) + (snippets.length ? 1 : 0);
          if (spent + base + 4 > available) continue;
          const room = available - spent - base;
          for (const character of item.content) {
            const candidate = snippet.content + character;
            if (Buffer.byteLength(JSON.stringify(candidate)) - 2 > room) break;
            snippet.content = candidate;
          }
          if (!snippet.content) continue;
          spent += Buffer.byteLength(JSON.stringify(snippet)) + (snippets.length ? 1 : 0);
          snippets.push(snippet);
          ledger.db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,?,?,?)").run(...keys);
          if (snippets.length === 3) break;
        }
        const cost = snippets.length ? spent : 0;
        ledger.db.prepare("UPDATE sessions SET used=used+? WHERE root=?").run(cost, ticket.root);
        ledger.db.prepare("UPDATE requests SET used=used+? WHERE root=? AND recipient=? AND request=?")
          .run(cost, ticket.root, ticket.recipient, ticket.request);
        await loadBinding(command.reference);
        ledger.current(ticket);
        ledger.db.exec("COMMIT");
        return {
          status: snippets.length ? "ok" : matches.items.length ? (duplicate ? "already_delivered" : "budget_exhausted") : "no_match",
          snippets, chargedTokens: cost, accounting: "conservative_utf8_bytes",
          requestRemaining: 800 - requestUsed - cost, sessionRemaining: 6_000 - sessionUsed - cost,
        };
        });
      } catch (error) {
        if (ledger.db.isTransaction) ledger.db.exec("ROLLBACK");
        throw error;
      }
    } finally { store.close(); }
  } finally { ledger.close(); }
}
parentPort?.on("message", async (message: { id: number; payload: unknown }) => {
  try { parentPort?.postMessage({ id: message.id, value: await execute(message.payload) }); }
  catch (error) {
    const code = error instanceof ToolError || error instanceof MemoryError || error instanceof BindingError
      ? error.code : "WORKER_OPERATION_FAILED";
    parentPort?.postMessage({ id: message.id, code, details: error instanceof MemoryError ? error.details : {} });
  }
});
