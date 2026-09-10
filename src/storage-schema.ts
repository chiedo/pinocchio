import type { DatabaseSync } from "node:sqlite";
import { fingerprint } from "./binding-registry.js";
import type { BindingRecord } from "./binding-registry.js";
import { MemoryError } from "./memory-types.js";

export const STORAGE_SCHEMA_VERSION = 1;
const APPLICATION_ID = 0x50494e4f;

// Published migrations are immutable; a schema change needs a new version.
export const MIGRATION_1 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
) STRICT;
CREATE TABLE store_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  namespace TEXT NOT NULL, definition_id TEXT NOT NULL
) STRICT;
CREATE TABLE scopes (
  scope TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))
) STRICT;
CREATE TABLE records (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES scopes(scope),
  revision INTEGER NOT NULL CHECK(revision > 0),
  status TEXT NOT NULL CHECK(status IN ('active','tentative','superseded','forgotten')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX records_scope ON records(scope, status, updated_at, id);
CREATE TABLE revisions (
  record_id TEXT NOT NULL REFERENCES records(id), revision INTEGER NOT NULL,
  content TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','tentative','superseded')),
  evidence_json TEXT NOT NULL, source_at TEXT, confirmed_at TEXT, recorded_at TEXT NOT NULL,
  PRIMARY KEY(record_id, revision)
) STRICT;
CREATE TABLE keyword_entries (
  record_id TEXT PRIMARY KEY REFERENCES records(id), revision INTEGER NOT NULL,
  literal_text TEXT NOT NULL,
  FOREIGN KEY(record_id, revision) REFERENCES revisions(record_id, revision)
) STRICT;
CREATE TABLE keyword_terms (
  record_id TEXT NOT NULL REFERENCES keyword_entries(record_id) ON DELETE CASCADE,
  term TEXT NOT NULL, PRIMARY KEY(record_id, term)
) STRICT;
CREATE INDEX keyword_lookup ON keyword_terms(term, record_id);
CREATE TABLE index_jobs (
  record_id TEXT NOT NULL REFERENCES records(id), revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
  status TEXT NOT NULL CHECK(status IN ('pending','cancelled','done')),
  embedding_model TEXT, indexed_revision INTEGER,
  PRIMARY KEY(record_id, revision)
) STRICT;
CREATE TABLE operations (
  scope TEXT NOT NULL REFERENCES scopes(scope), operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('remember','correct','forget','disable','enable')),
  request_hash TEXT, record_id TEXT REFERENCES records(id), revision INTEGER,
  recorded_at TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
  PRIMARY KEY(scope, operation_id)
) STRICT;
`;

export function initializeStorage(db: DatabaseSync, binding: BindingRecord, scope: string) {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  const application = db.prepare("PRAGMA application_id").get()?.application_id;
  if (typeof version !== "number" || version > STORAGE_SCHEMA_VERSION ||
      (application !== 0 && application !== APPLICATION_ID)) {
    throw new MemoryError("SCHEMA_UNSUPPORTED");
  }
  db.exec("PRAGMA busy_timeout=250; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
  const journal = db.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode;
  if (journal !== "delete") throw new MemoryError("SCHEMA_UNSUPPORTED");
  db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
  try {
    const current = db.prepare("PRAGMA user_version").get()?.user_version;
    if (current === 0) {
      const tables = db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()?.count;
      if (tables !== 0) throw new MemoryError("SCHEMA_UNSUPPORTED");
      db.exec(MIGRATION_1);
      db.prepare("INSERT INTO schema_migrations VALUES (1, ?, ?)").run(fingerprint(MIGRATION_1), new Date().toISOString());
      db.prepare("INSERT INTO store_metadata VALUES (1, ?, ?)").run(binding.namespace, binding.definition.id);
      db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1`);
    } else if (current !== STORAGE_SCHEMA_VERSION) {
      throw new MemoryError("SCHEMA_UNSUPPORTED");
    }
    if (db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID ||
        db.prepare("SELECT checksum FROM schema_migrations WHERE version=1").get()?.checksum !== fingerprint(MIGRATION_1)) {
      throw new MemoryError("SCHEMA_MISMATCH");
    }
    const owner = db.prepare("SELECT namespace, definition_id FROM store_metadata WHERE singleton=1").get();
    if (owner?.namespace !== binding.namespace || owner.definition_id !== binding.definition.id) {
      throw new MemoryError("SCOPE_MISMATCH");
    }
    db.prepare("INSERT OR IGNORE INTO scopes(scope) VALUES (?)").run(scope);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
