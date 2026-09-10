import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fingerprint, hasCode, privateDirectory } from "./binding-registry.js";
import { privateStoreFile } from "./storage-files.js";
import { canonical, ticketSchema, ToolError } from "./memory-protocol.js";
import type { ContextTicket } from "./memory-protocol.js";

export class ContextLedger {
  private constructor(readonly db: DatabaseSync, readonly key: Buffer) {}
  static async open(root: string) {
    if (await realpath(root) !== root) throw new ToolError("INVALID_CONFIG_ROOT");
    await privateDirectory(join(root, "pinocchio"), true);
    const directory = join(root, "pinocchio", "context");
    await privateDirectory(directory, true);
    const secret = join(directory, "key");
    try {
      const handle = await open(secret, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    await privateStoreFile(secret);
    const handle = await open(secret, constants.O_RDONLY | constants.O_NOFOLLOW);
    let key: Buffer;
    try { key = await handle.readFile(); } finally { await handle.close(); }
    if (key.length !== 32) throw new ToolError("INVALID_CONTEXT_KEY");
    const path = join(directory, "context.sqlite");
    try {
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.sync(); } finally { await file.close(); }
    } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    await privateStoreFile(path);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try { await privateStoreFile(path + suffix); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    }
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new ToolError("CONTEXT_SCHEMA_UNSUPPORTED");
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; BEGIN IMMEDIATE");
      if (db.prepare("PRAGMA user_version").get()?.user_version === 0) {
        if (db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()?.n !== 0) {
          throw new ToolError("CONTEXT_SCHEMA_UNSUPPORTED");
        }
        db.exec(`
          CREATE TABLE sessions(root TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0) STRICT;
          CREATE TABLE requests(root TEXT NOT NULL, recipient TEXT NOT NULL, request TEXT NOT NULL,
            stamp TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(root,recipient,request)) STRICT;
          CREATE TABLE current_requests(root TEXT NOT NULL, recipient TEXT NOT NULL, request TEXT NOT NULL, stamp TEXT NOT NULL,
            PRIMARY KEY(root,recipient)) STRICT;
          CREATE TABLE deliveries(root TEXT NOT NULL, recipient TEXT NOT NULL, request TEXT NOT NULL,
            generation INTEGER NOT NULL, namespace TEXT NOT NULL, scope TEXT NOT NULL, record TEXT NOT NULL, revision INTEGER NOT NULL,
            PRIMARY KEY(root,recipient,request,generation,namespace,scope,record,revision)) STRICT;
          PRAGMA application_id=1346981443; PRAGMA user_version=1;
        `);
      }
      if (db.prepare("PRAGMA application_id").get()?.application_id !== 1346981443) {
        throw new ToolError("CONTEXT_SCHEMA_UNSUPPORTED");
      }
      db.exec("COMMIT");
      return new ContextLedger(db, key);
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); throw error; }
  }
  close() { this.db.close(); }
  #sign(value: unknown) { return createHmac("sha256", this.key).update(canonical(value)).digest("hex"); }
  start(rootId: string, recipientId: string, stamp: string) {
    if (!rootId || !recipientId || !Number.isFinite(Date.parse(stamp))) throw new ToolError("MISSING_REQUEST_CONTEXT");
    const root = fingerprint(rootId), recipient = fingerprint(recipientId);
    const request = fingerprint(canonical([root, recipient, stamp]));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO sessions(root) VALUES (?)").run(root);
      this.db.prepare("INSERT OR IGNORE INTO requests(root,recipient,request,stamp) VALUES (?,?,?,?)")
        .run(root, recipient, request, stamp);
      this.db.prepare(`INSERT INTO current_requests VALUES (?,?,?,?)
        ON CONFLICT(root,recipient) DO UPDATE SET request=excluded.request,stamp=excluded.stamp
        WHERE excluded.stamp>current_requests.stamp`).run(root, recipient, request, stamp);
      this.db.exec("COMMIT");
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
    return { status: "ready" };
  }
  invalidate(rootId: string) {
    this.db.prepare("UPDATE sessions SET generation=generation+1 WHERE root=?").run(fingerprint(rootId));
    return { status: "ready" };
  }
  issue(input: { root: string; recipient: string; call: string; server: string; tool: string; directory: string; arguments: unknown; deadline: number }) {
    const root = fingerprint(input.root), recipient = fingerprint(input.recipient);
    const current = this.db.prepare("SELECT request FROM current_requests WHERE root=? AND recipient=?").get(root, recipient);
    if (typeof current?.request !== "string" || !input.call) throw new ToolError("MISSING_REQUEST_CONTEXT");
    const body = {
      version: 1 as const, root, recipient, request: current.request, call: input.call,
      server: input.server, tool: input.tool, argumentsHash: fingerprint(canonical(input.arguments)),
      directory: input.directory,
      deadline: input.deadline,
    };
    return ticketSchema.parse({ ...body, signature: this.#sign(body) });
  }
  verify(raw: unknown, server: string, tool: string, args: unknown): ContextTicket {
    const parsed = ticketSchema.safeParse(raw);
    if (!parsed.success) throw new ToolError("MISSING_REQUEST_CONTEXT");
    const { signature, ...body } = parsed.data;
    const actual = Buffer.from(signature, "hex"), expected = Buffer.from(this.#sign(body), "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
        body.server !== server || body.tool !== tool || body.argumentsHash !== fingerprint(canonical(args))) {
      throw new ToolError("INVALID_REQUEST_CONTEXT");
    }
    this.current(parsed.data);
    return parsed.data;
  }
  current(ticket: ContextTicket) {
    if (Date.now() >= ticket.deadline) throw new ToolError("MEMORY_DEADLINE");
    const current = this.db.prepare("SELECT request FROM current_requests WHERE root=? AND recipient=?")
      .get(ticket.root, ticket.recipient);
    if (current?.request !== ticket.request) throw new ToolError("STALE_REQUEST");
  }
}
