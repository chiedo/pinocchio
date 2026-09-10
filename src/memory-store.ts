import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { BindingError, fingerprint, loadBinding } from "./binding-registry.js";
import type { BindingReference, BindingRecord } from "./binding-registry.js";
import {
  MemoryError, keywords, normalizeText, noteSchema, operationIdSchema, recordIdSchema,
  revisionSchema, validate, validateEvidence,
} from "./memory-types.js";
import type { MemoryReceipt, Note, NoteInput } from "./memory-types.js";
import { initializeStorage, STORAGE_SCHEMA_VERSION } from "./storage-schema.js";
import { privateStoreFile, storePath } from "./storage-files.js";
import type { StoreFileIdentity } from "./storage-files.js";

const stateSchema = z.object({
  id: z.string(), scope: z.string(), revision: z.number().int(),
  status: z.enum(["active", "tentative", "superseded", "forgotten"]),
  created_at: z.string(), updated_at: z.string(),
});
const operationSchema = z.object({
  operation_id: z.string(), action: z.enum(["remember", "correct", "forget", "disable", "enable"]),
  request_hash: z.string().nullable(), record_id: z.string().nullable(),
  revision: z.number().nullable(), recorded_at: z.string(), retired: z.number(),
});
const paginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(1_000_000).default(0),
}).strict();
const viewSchema = stateSchema.extend({
  content: z.string(), kind: z.string(), evidence_json: z.string(),
  source_at: z.string().nullable(), confirmed_at: z.string().nullable(), recorded_at: z.string(),
});
type Action = MemoryReceipt["action"];
type OperationRow = z.infer<typeof operationSchema>;

function databaseError(error: unknown): Error {
  if (error instanceof MemoryError || error instanceof BindingError) return error;
  if (typeof error === "object" && error !== null && "errcode" in error &&
      typeof error.errcode === "number") {
    const primary = error.errcode & 0xff;
    if (primary === 5 || primary === 6) return new MemoryError("STORE_BUSY");
    if (primary === 11 || primary === 26) return new MemoryError("STORE_CORRUPT");
  }
  return new MemoryError("STORE_IO_ERROR");
}
function view(row: unknown) {
  const parsed = viewSchema.safeParse(row);
  if (!parsed.success) throw new MemoryError("STORE_CORRUPT");
  const { evidence_json, ...data } = parsed.data;
  let evidence: unknown;
  try { evidence = JSON.parse(evidence_json); } catch { throw new MemoryError("STORE_CORRUPT"); }
  return { ...data, evidence };
}
const SELECT_CURRENT = `
SELECT r.*, v.content, v.kind, v.evidence_json, v.source_at, v.confirmed_at, v.recorded_at
FROM records r JOIN revisions v ON v.record_id=r.id AND v.revision=r.revision`;

export class MemoryStore {
  readonly #reference: Readonly<BindingReference>;
  readonly #binding: BindingRecord;
  readonly #db: DatabaseSync;
  readonly #file: StoreFileIdentity;
  readonly #scope: string;
  readonly path: string;
  #busy = false;
  #closed = false;
  private constructor(reference: BindingReference, binding: BindingRecord, db: DatabaseSync, path: string, file: StoreFileIdentity) {
    this.#reference = Object.freeze({ ...reference });
    this.#binding = binding;
    this.#db = db;
    this.path = path;
    this.#file = file;
    this.#scope = `${binding.scope.kind}:${binding.scope.key}`;
  }
  static async open(
    reference: BindingReference,
    selection: { namespace: string; scope: "repository" | "global" },
  ) {
    let db: DatabaseSync | undefined;
    try {
      const binding = await loadBinding(reference);
      if (binding.namespace !== selection.namespace || binding.scope.kind !== selection.scope) {
        throw new MemoryError("SCOPE_MISMATCH");
      }
      const path = await storePath(reference.configRoot, binding.namespace, true);
      const file = await privateStoreFile(path);
      db = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
      initializeStorage(db, binding, `${binding.scope.kind}:${binding.scope.key}`);
      await loadBinding(reference);
      return new MemoryStore(reference, binding, db, path, file);
    } catch (error) {
      db?.close();
      throw databaseError(error);
    }
  }
  close() {
    if (this.#busy) throw new MemoryError("STORE_BUSY");
    if (!this.#closed) { this.#db.close(); this.#closed = true; }
  }
  async #validate(signal?: AbortSignal) {
    if (signal?.aborted) throw new MemoryError("CALL_CANCELLED");
    await loadBinding(this.#reference, signal);
    await storePath(this.#reference.configRoot, this.#binding.namespace, false);
    const current = await privateStoreFile(this.path);
    if (current.device !== this.#file.device || current.inode !== this.#file.inode) {
      throw new MemoryError("STORE_REPLACED");
    }
  }
  async #transaction<T>(
    work: () => Promise<T> | T,
    options: { allowDisabled?: boolean; operationId?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.#closed) throw new MemoryError("STORE_CLOSED");
    if (this.#busy) throw new MemoryError("STORE_BUSY");
    this.#busy = true;
    let committing = false;
    let committed = false;
    try {
      await this.#validate(options.signal);
      this.#db.exec("BEGIN IMMEDIATE");
      if (!options.allowDisabled && this.#db.prepare("SELECT disabled FROM scopes WHERE scope=?").get(this.#scope)?.disabled !== 0) {
        throw new MemoryError("STORE_DISABLED");
      }
      const result = await work();
      await this.#validate(options.signal);
      committing = true;
      this.#db.exec("COMMIT");
      committed = true;
      await this.#validate(options.signal);
      return result;
    } catch (error) {
      const unknown = options.operationId && (committed || (committing && !this.#db.isTransaction));
      if (this.#db.isTransaction) {
        try { this.#db.exec("ROLLBACK"); }
        catch { throw new MemoryError("ROLLBACK_FAILED", options.operationId ? { operationId: options.operationId } : {}); }
      }
      if (unknown && options.operationId) throw new MemoryError("OUTCOME_UNKNOWN", { operationId: options.operationId });
      throw databaseError(error);
    } finally { this.#busy = false; }
  }
  #record(id: string) {
    const row = this.#db.prepare("SELECT * FROM records WHERE id=? AND scope=?").get(id, this.#scope);
    if (!row) throw new MemoryError("NOT_FOUND");
    const parsed = stateSchema.safeParse(row);
    if (!parsed.success) throw new MemoryError("STORE_CORRUPT");
    return parsed.data;
  }
  #operation(id: string): OperationRow | undefined {
    const row = this.#db.prepare("SELECT * FROM operations WHERE scope=? AND operation_id=?").get(this.#scope, id);
    if (!row) return undefined;
    const parsed = operationSchema.safeParse(row);
    if (!parsed.success) throw new MemoryError("STORE_CORRUPT");
    return parsed.data;
  }
  #receipt(row: OperationRow, replayed: boolean): MemoryReceipt {
    return {
      status: "committed", operationId: row.operation_id, action: row.action,
      recordId: row.record_id, revision: row.revision, recordedAt: row.recorded_at, replayed,
      ...(row.retired ? { recordStatus: "forgotten" as const } : {}),
    };
  }
  async #mutate(
    action: Action, operationId: string, request: unknown,
    work: (now: string) => Promise<{ recordId: string | null; revision: number | null }> |
      { recordId: string | null; revision: number | null },
    signal?: AbortSignal,
  ) {
    validate(operationIdSchema, operationId);
    const hash = fingerprint(JSON.stringify({ action, request }));
    return this.#transaction(async () => {
      const previous = this.#operation(operationId);
      if (previous) {
        if (previous.retired) throw new MemoryError("OPERATION_RETIRED", { operationId });
        if (previous.action !== action || previous.request_hash !== hash) {
          throw new MemoryError("OPERATION_CONFLICT", { operationId });
        }
        return this.#receipt(previous, true);
      }
      const now = new Date().toISOString();
      const result = await work(now);
      this.#db.prepare(`INSERT INTO operations
        (scope,operation_id,action,request_hash,record_id,revision,recorded_at) VALUES (?,?,?,?,?,?,?)`)
        .run(this.#scope, operationId, action, hash, result.recordId, result.revision, now);
      return {
        status: "committed" as const, operationId, action, ...result, recordedAt: now, replayed: false,
      };
    }, {
      operationId, allowDisabled: action === "disable" || action === "enable",
      ...(signal ? { signal } : {}),
    });
  }
  async #revision(recordId: string, revision: number, note: Note, now: string) {
    const terms = keywords(note.content);
    if (terms.length > 4_096) throw new MemoryError("INVALID_INPUT");
    const evidence = await validateEvidence(note, this.#binding);
    this.#db.prepare(`INSERT INTO revisions
      (record_id,revision,content,kind,status,evidence_json,source_at,confirmed_at,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(recordId, revision, note.content, note.kind, note.status,
        JSON.stringify(evidence), note.sourceAt ?? null, note.confirmedAt ?? null, now);
    this.#db.prepare("DELETE FROM keyword_entries WHERE record_id=?").run(recordId);
    if (note.status !== "superseded") {
      this.#db.prepare("INSERT INTO keyword_entries VALUES (?,?,?)").run(recordId, revision, normalizeText(note.content));
      const insert = this.#db.prepare("INSERT INTO keyword_terms VALUES (?,?)");
      for (const term of terms) insert.run(recordId, term);
    }
    this.#db.prepare("UPDATE index_jobs SET status='cancelled' WHERE record_id=? AND status='pending'").run(recordId);
    this.#db.prepare("INSERT INTO index_jobs(record_id,revision,action,status) VALUES (?,?,?,'pending')")
      .run(recordId, revision, note.status === "superseded" ? "delete" : "upsert");
  }
  remember(input: NoteInput, operationId: string, signal?: AbortSignal) {
    const note = validate(noteSchema, input);
    return this.#mutate("remember", operationId, note, async (now) => {
      const recordId = randomUUID();
      this.#db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?)")
        .run(recordId, this.#scope, 1, note.status, now, now);
      await this.#revision(recordId, 1, note, now);
      return { recordId, revision: 1 };
    }, signal);
  }
  correct(recordId: string, expectedRevision: number, input: NoteInput, operationId: string, signal?: AbortSignal) {
    validate(recordIdSchema, recordId); validate(revisionSchema, expectedRevision);
    const note = validate(noteSchema, input);
    return this.#mutate("correct", operationId, { recordId, expectedRevision, note }, async (now) => {
      const record = this.#record(recordId);
      if (record.status === "forgotten") throw new MemoryError("RECORD_FORGOTTEN");
      if (record.revision !== expectedRevision) throw new MemoryError("REVISION_CONFLICT", { currentRevision: record.revision });
      const revision = record.revision + 1;
      this.#db.prepare("UPDATE records SET revision=?,status=?,updated_at=? WHERE id=? AND scope=?")
        .run(revision, note.status, now, recordId, this.#scope);
      await this.#revision(recordId, revision, note, now);
      return { recordId, revision };
    }, signal);
  }
  forget(recordId: string, expectedRevision: number, operationId: string, signal?: AbortSignal) {
    validate(recordIdSchema, recordId); validate(revisionSchema, expectedRevision);
    return this.#mutate("forget", operationId, { recordId, expectedRevision }, (now) => {
      const record = this.#record(recordId);
      if (record.revision !== expectedRevision) throw new MemoryError("REVISION_CONFLICT", { currentRevision: record.revision });
      if (record.status === "forgotten") return { recordId, revision: record.revision };
      const revision = record.revision + 1;
      this.#db.prepare("DELETE FROM keyword_entries WHERE record_id=?").run(recordId);
      this.#db.prepare("DELETE FROM revisions WHERE record_id=?").run(recordId);
      this.#db.prepare("UPDATE index_jobs SET status='cancelled' WHERE record_id=?").run(recordId);
      this.#db.prepare("UPDATE operations SET request_hash=NULL,retired=1 WHERE scope=? AND record_id=?")
        .run(this.#scope, recordId);
      this.#db.prepare("UPDATE records SET revision=?,status='forgotten',updated_at=? WHERE id=? AND scope=?")
        .run(revision, now, recordId, this.#scope);
      return { recordId, revision };
    }, signal);
  }
  setDisabled(disabled: boolean, operationId: string, signal?: AbortSignal) {
    if (typeof disabled !== "boolean") throw new MemoryError("INVALID_INPUT");
    return this.#mutate(disabled ? "disable" : "enable", operationId, { disabled }, () => {
      this.#db.prepare("UPDATE scopes SET disabled=? WHERE scope=?").run(disabled ? 1 : 0, this.#scope);
      return { recordId: null, revision: null };
    }, signal);
  }
  list(pagination: { limit?: number; offset?: number } = {}) {
    const { limit, offset } = validate(paginationSchema, pagination);
    return this.#transaction(() => ({
      status: "ok" as const,
      items: this.#db.prepare(`${SELECT_CURRENT} WHERE r.scope=? AND r.status!='forgotten'
        ORDER BY r.updated_at DESC, r.id LIMIT ? OFFSET ?`).all(this.#scope, limit, offset).map(view),
    }));
  }
  search(query: string, pagination: { limit?: number; offset?: number } = {}) {
    validate(z.string().min(1).max(500).refine((value) => Boolean(value.trim())), query);
    const terms = keywords(query);
    if (terms.length > 64) throw new MemoryError("INVALID_INPUT");
    const { limit, offset } = validate(paginationSchema, pagination);
    const literal = normalizeText(query);
    const keywordMatch = terms.length
      ? `OR r.id IN (SELECT record_id FROM keyword_terms WHERE term IN (${terms.map(() => "?").join(",")})
        GROUP BY record_id HAVING count(*)=?)` : "";
    return this.#transaction(() => {
      const rows = this.#db.prepare(`${SELECT_CURRENT}
        JOIN keyword_entries k ON k.record_id=r.id AND k.revision=r.revision
        WHERE r.scope=? AND r.status IN ('active','tentative')
        AND (instr(k.literal_text,?)>0 ${keywordMatch})
        ORDER BY (instr(k.literal_text,?)>0) DESC, r.updated_at DESC, r.id LIMIT ? OFFSET ?`)
        .all(this.#scope, literal, ...(terms.length ? [...terms, terms.length] : []), literal, limit, offset);
      return { status: rows.length ? "ok" as const : "no_match" as const, items: rows.map(view) };
    });
  }
  inspect(recordId: string, pagination: { limit?: number; offset?: number } = {}) {
    validate(recordIdSchema, recordId);
    const { limit, offset } = validate(paginationSchema, pagination);
    return this.#transaction(() => {
      const record = this.#record(recordId);
      const revisions = this.#db.prepare(`SELECT r.id,r.scope,v.revision,v.status,r.created_at,r.updated_at,
        v.content,v.kind,v.evidence_json,v.source_at,v.confirmed_at,v.recorded_at
        FROM records r JOIN revisions v ON v.record_id=r.id
        WHERE r.scope=? AND r.id=? ORDER BY v.revision DESC LIMIT ? OFFSET ?`)
        .all(this.#scope, recordId, limit, offset).map(view);
      return { status: record.status === "forgotten" ? "forgotten" as const : "ok" as const, record, revisions };
    });
  }
  operationStatus(operationId: string) {
    validate(operationIdSchema, operationId);
    return this.#transaction(() => {
      const row = this.#operation(operationId);
      return row ? this.#receipt(row, true) : { status: "not_found" as const, operationId };
    }, { allowDisabled: true });
  }
  status() {
    return this.#transaction(() => ({
      status: "ok" as const,
      namespace: this.#binding.namespace,
      scope: { kind: this.#binding.scope.kind, key: this.#binding.scope.key },
      schemaVersion: STORAGE_SCHEMA_VERSION,
      disabled: this.#db.prepare("SELECT disabled FROM scopes WHERE scope=?").get(this.#scope)?.disabled === 1,
      records: this.#db.prepare("SELECT status,count(*) AS count FROM records WHERE scope=? GROUP BY status").all(this.#scope),
      indexJobs: this.#db.prepare(`SELECT j.status,count(*) AS count FROM index_jobs j
        JOIN records r ON r.id=j.record_id WHERE r.scope=? GROUP BY j.status`).all(this.#scope),
      deletion: "logical; secure_delete enabled; backups and filesystem erasure are outside this store",
    }), { allowDisabled: true });
  }
}
