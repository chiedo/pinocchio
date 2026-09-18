import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { loadBinding, privateDirectory } from "./binding-registry.js";
import type { BindingReference } from "./binding-registry.js";
import { githubJobSourceSchema } from "./local-job-sources.js";
import type { GitHubJobSource } from "./local-job-sources.js";

const backendSchema = z.enum(["local", "cloud"]);
const stateSchema = z.enum(["enabled", "paused", "deleted"]);
const runStatusSchema = z.enum([
  "claimed", "running", "cancelling", "succeeded", "failed", "blocked",
  "cancelled", "interrupted", "outcome_unknown",
]);

export type JobBackend = z.infer<typeof backendSchema>;
export type JobRunStatus = z.infer<typeof runStatusSchema>;

export interface StoredJob {
  uid: string;
  ownerBindingId: string;
  ownerFingerprint: string;
  ownerAgent: string;
  ownerScope: string;
  slug: string;
  backend: JobBackend;
  repository?: string;
  revision: number;
  prompt: string;
  cron: string;
  timezone: string;
  workingDirectory: string;
  requiredTools: string[];
  timeoutMinutes: number;
  maxAiCredits?: number;
  source?: GitHubJobSource;
  state: "enabled" | "paused" | "deleted";
  approvalFingerprint: string;
  nextDueAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredRun {
  runId: string;
  jobUid: string;
  jobRevision: number;
  occurrenceKey: string;
  backend: JobBackend;
  status: JobRunStatus;
  hostSessionId?: string;
  runtimeTaskId?: string;
  remoteRunId?: string;
  startedAt: string;
  completedAt?: string;
  result?: string;
  errorCode?: string;
  readAt?: string;
  sourceCommit?: string;
  definitionFingerprint?: string;
}

interface JobRow {
  uid: string;
  owner_binding_id: string;
  owner_fingerprint: string;
  owner_agent: string;
  owner_scope: string;
  slug: string;
  backend: string;
  repository: string | null;
  revision: number;
  prompt: string;
  cron: string;
  timezone: string;
  working_directory: string;
  required_tools: string;
  timeout_minutes: number;
  max_ai_credits: number | null;
  source_json: string;
  state: string;
  approval_fingerprint: string;
  next_due_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  run_id: string;
  job_uid: string;
  job_revision: number;
  occurrence_key: string;
  backend: string;
  status: string;
  host_session_id: string | null;
  runtime_task_id: string | null;
  remote_run_id: string | null;
  started_at: string;
  completed_at: string | null;
  result: string | null;
  error_code: string | null;
  read_at: string | null;
  source_commit: string | null;
  definition_fingerprint: string | null;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function jobFromRow(row: JobRow): StoredJob {
  return {
    uid: row.uid,
    ownerBindingId: row.owner_binding_id,
    ownerFingerprint: row.owner_fingerprint,
    ownerAgent: row.owner_agent,
    ownerScope: row.owner_scope,
    slug: row.slug,
    backend: backendSchema.parse(row.backend),
    ...(row.repository ? { repository: row.repository } : {}),
    revision: row.revision,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    workingDirectory: row.working_directory,
    requiredTools: z.array(z.string()).parse(JSON.parse(row.required_tools)),
    timeoutMinutes: row.timeout_minutes,
    ...(row.max_ai_credits === null ? {} : { maxAiCredits: row.max_ai_credits }),
    ...(row.source_json ? {
      source: githubJobSourceSchema.parse(JSON.parse(row.source_json)),
    } : {}),
    state: stateSchema.parse(row.state),
    approvalFingerprint: row.approval_fingerprint,
    ...(row.next_due_at ? { nextDueAt: row.next_due_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row: RunRow): StoredRun {
  return {
    runId: row.run_id,
    jobUid: row.job_uid,
    jobRevision: row.job_revision,
    occurrenceKey: row.occurrence_key,
    backend: backendSchema.parse(row.backend),
    status: runStatusSchema.parse(row.status),
    ...(row.host_session_id ? { hostSessionId: row.host_session_id } : {}),
    ...(row.runtime_task_id ? { runtimeTaskId: row.runtime_task_id } : {}),
    ...(row.remote_run_id ? { remoteRunId: row.remote_run_id } : {}),
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.read_at ? { readAt: row.read_at } : {}),
    ...(row.source_commit ? { sourceCommit: row.source_commit } : {}),
    ...(row.definition_fingerprint
      ? { definitionFingerprint: row.definition_fingerprint }
      : {}),
  };
}

export class JobsStore {
  private constructor(
    readonly root: string,
    private readonly database: DatabaseSync,
  ) {}

  static async open(configRoot: string) {
    const root = join(configRoot, "pinocchio", "jobs");
    await mkdir(join(configRoot, "pinocchio"), { recursive: true, mode: 0o700 });
    await privateDirectory(join(configRoot, "pinocchio"), false);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await privateDirectory(root, false);
    const databasePath = join(root, "jobs.sqlite");
    const database = new DatabaseSync(databasePath);
    await chmod(databasePath, 0o600);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS jobs (
        uid TEXT PRIMARY KEY,
        owner_binding_id TEXT NOT NULL,
        owner_fingerprint TEXT NOT NULL,
        owner_agent TEXT NOT NULL,
        owner_scope TEXT NOT NULL,
        slug TEXT NOT NULL,
        backend TEXT NOT NULL CHECK (backend IN ('local','cloud')),
        repository TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        required_tools TEXT NOT NULL,
        timeout_minutes INTEGER NOT NULL,
        max_ai_credits INTEGER,
        source_json TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL CHECK (state IN ('enabled','paused','deleted')),
        approval_fingerprint TEXT NOT NULL,
        next_due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_binding_id, backend, repository, slug)
      );
      CREATE TABLE IF NOT EXISTS job_drafts (
        draft_id TEXT PRIMARY KEY,
        owner_binding_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        approval_token TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_runs (
        run_id TEXT PRIMARY KEY,
        job_uid TEXT NOT NULL REFERENCES jobs(uid) ON DELETE CASCADE,
        job_revision INTEGER NOT NULL,
        occurrence_key TEXT NOT NULL,
        backend TEXT NOT NULL CHECK (backend IN ('local','cloud')),
        status TEXT NOT NULL,
        host_session_id TEXT,
        runtime_task_id TEXT,
        remote_run_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        result TEXT,
        error_code TEXT,
        read_at TEXT,
        source_commit TEXT,
        definition_fingerprint TEXT,
        UNIQUE(job_uid, occurrence_key)
      );
      CREATE INDEX IF NOT EXISTS job_owner_index
        ON jobs(owner_binding_id, backend, state);
      CREATE INDEX IF NOT EXISTS job_due_index
        ON jobs(backend, state, next_due_at);
      CREATE INDEX IF NOT EXISTS job_run_index
        ON job_runs(job_uid, started_at DESC);
      CREATE INDEX IF NOT EXISTS job_runtime_task_index
        ON job_runs(runtime_task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS job_single_active_run
        ON job_runs(job_uid)
        WHERE status IN ('claimed','running','cancelling');
    `);
    const jobColumns = new Set((database.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
    }[]).map((column) => column.name));
    if (!jobColumns.has("source_json")) {
      database.exec("ALTER TABLE jobs ADD COLUMN source_json TEXT NOT NULL DEFAULT ''");
    }
    const runColumns = new Set((database.prepare("PRAGMA table_info(job_runs)").all() as {
      name: string;
    }[]).map((column) => column.name));
    if (!runColumns.has("source_commit")) {
      database.exec("ALTER TABLE job_runs ADD COLUMN source_commit TEXT");
    }
    if (!runColumns.has("definition_fingerprint")) {
      database.exec("ALTER TABLE job_runs ADD COLUMN definition_fingerprint TEXT");
    }
    return new JobsStore(root, database);
  }

  close() {
    this.database.close();
  }

  async owner(reference: BindingReference) {
    const binding = await loadBinding(reference);
    return {
      bindingId: reference.bindingId,
      fingerprint: reference.fingerprint,
      agent: basename(binding.definition.path, ".agent.md"),
      scope: binding.scope.kind === "global"
        ? "global"
        : `repository:${binding.scope.root}`,
    };
  }

  saveDraft(reference: BindingReference, payload: unknown) {
    const draftId = randomUUID();
    const serialized = JSON.stringify(payload);
    const approvalToken = digest(JSON.stringify({
      version: 1,
      draftId,
      ownerBindingId: reference.bindingId,
      ownerFingerprint: reference.fingerprint,
      payload,
    }));
    this.database.prepare(`
      INSERT INTO job_drafts(draft_id,owner_binding_id,payload,approval_token,expires_at)
      VALUES(?,?,?,?,?)
    `).run(
      draftId,
      reference.bindingId,
      serialized,
      approvalToken,
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    );
    return { draftId, approvalToken };
  }

  consumeDraft(reference: BindingReference, draftId: string, approvalToken: string) {
    const row = this.database.prepare(`
      SELECT owner_binding_id,payload,approval_token,expires_at
      FROM job_drafts WHERE draft_id=?
    `).get(draftId) as {
      owner_binding_id: string;
      payload: string;
      approval_token: string;
      expires_at: string;
    } | undefined;
    if (!row || row.owner_binding_id !== reference.bindingId ||
        row.approval_token !== approvalToken ||
        Date.parse(row.expires_at) <= Date.now()) {
      throw Object.assign(new Error("JOB_DRAFT_APPROVAL_MISMATCH"), {
        code: "JOB_DRAFT_APPROVAL_MISMATCH",
      });
    }
    this.database.prepare("DELETE FROM job_drafts WHERE draft_id=?").run(draftId);
    return JSON.parse(row.payload) as unknown;
  }

  putJob(job: StoredJob) {
    this.database.prepare(`
      INSERT INTO jobs(
        uid,owner_binding_id,owner_fingerprint,owner_agent,owner_scope,slug,
        backend,repository,revision,prompt,cron,timezone,working_directory,
        required_tools,timeout_minutes,max_ai_credits,source_json,state,approval_fingerprint,
        next_due_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_binding_id,backend,repository,slug) DO UPDATE SET
        owner_fingerprint=excluded.owner_fingerprint,
        owner_agent=excluded.owner_agent,
        owner_scope=excluded.owner_scope,
        revision=excluded.revision,
        prompt=excluded.prompt,
        cron=excluded.cron,
        timezone=excluded.timezone,
        working_directory=excluded.working_directory,
        required_tools=excluded.required_tools,
        timeout_minutes=excluded.timeout_minutes,
        max_ai_credits=excluded.max_ai_credits,
        source_json=excluded.source_json,
        state=excluded.state,
        approval_fingerprint=excluded.approval_fingerprint,
        next_due_at=excluded.next_due_at,
        updated_at=excluded.updated_at
    `).run(
      job.uid, job.ownerBindingId, job.ownerFingerprint, job.ownerAgent,
      job.ownerScope, job.slug, job.backend, job.repository ?? "", job.revision,
      job.prompt, job.cron, job.timezone, job.workingDirectory,
      JSON.stringify(job.requiredTools), job.timeoutMinutes,
      job.maxAiCredits ?? null, job.source ? JSON.stringify(job.source) : "",
      job.state, job.approvalFingerprint,
      job.nextDueAt ?? null, job.createdAt, job.updatedAt,
    );
    return this.getJob(job.ownerBindingId, job.backend, job.slug, job.repository);
  }

  getJob(
    ownerBindingId: string,
    backend: JobBackend,
    slug: string,
    repository?: string,
  ) {
    const row = this.database.prepare(`
      SELECT * FROM jobs
      WHERE owner_binding_id=? AND backend=? AND slug=?
        AND repository=? AND state!='deleted'
    `).get(ownerBindingId, backend, slug, repository ?? "") as JobRow | undefined;
    return row ? jobFromRow(row) : undefined;
  }

  getJobByUid(uid: string) {
    const row = this.database.prepare("SELECT * FROM jobs WHERE uid=?")
      .get(uid) as JobRow | undefined;
    return row ? jobFromRow(row) : undefined;
  }

  listJobs(ownerBindingId: string, backend?: JobBackend) {
    const rows = (backend
      ? this.database.prepare(`
          SELECT * FROM jobs WHERE owner_binding_id=? AND backend=? AND state!='deleted'
          ORDER BY backend,slug
        `).all(ownerBindingId, backend)
      : this.database.prepare(`
          SELECT * FROM jobs WHERE owner_binding_id=? AND state!='deleted'
          ORDER BY backend,slug
        `).all(ownerBindingId)) as unknown as JobRow[];
    return rows.map(jobFromRow);
  }

  dueJobs(ownerBindingId: string, now: string) {
    const rows = this.database.prepare(`
      SELECT * FROM jobs
      WHERE owner_binding_id=? AND backend='local' AND state='enabled'
        AND next_due_at IS NOT NULL AND next_due_at<=?
      ORDER BY next_due_at
    `).all(ownerBindingId, now) as unknown as JobRow[];
    return rows.map(jobFromRow);
  }

  setNextDue(uid: string, nextDueAt: string) {
    this.database.prepare(
      "UPDATE jobs SET next_due_at=?,updated_at=? WHERE uid=?",
    ).run(nextDueAt, new Date().toISOString(), uid);
  }

  updateSource(uid: string, source: GitHubJobSource) {
    this.database.prepare(
      "UPDATE jobs SET source_json=?,updated_at=? WHERE uid=?",
    ).run(JSON.stringify(source), new Date().toISOString(), uid);
    return this.getJobByUid(uid);
  }

  setState(uid: string, state: "enabled" | "paused") {
    this.database.prepare(
      "UPDATE jobs SET state=?,updated_at=? WHERE uid=?",
    ).run(state, new Date().toISOString(), uid);
  }

  deleteJob(uid: string) {
    return this.database.prepare(
      "UPDATE jobs SET state='deleted',updated_at=? WHERE uid=?",
    ).run(new Date().toISOString(), uid)
      .changes > 0;
  }

  claimRun(
    job: StoredJob,
    occurrenceKey: string,
    hostSessionId?: string,
  ) {
    const runId = randomUUID();
    try {
      this.database.prepare(`
        INSERT INTO job_runs(
          run_id,job_uid,job_revision,occurrence_key,backend,status,
          host_session_id,started_at,source_commit,definition_fingerprint
        ) VALUES(?,?,?,?,?,'claimed',?,?,?,?)
      `).run(
        runId, job.uid, job.revision, occurrenceKey, job.backend,
        hostSessionId ?? null, new Date().toISOString(),
        job.source?.resolvedCommit ?? null,
        job.source?.definitionFingerprint ?? null,
      );
    } catch (error) {
      if (error instanceof Error &&
          error.message.includes("UNIQUE constraint failed")) return undefined;
      throw error;
    }
    return this.getRun(runId);
  }

  getRun(runId: string) {
    const row = this.database.prepare("SELECT * FROM job_runs WHERE run_id=?")
      .get(runId) as RunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  runForRuntimeTask(runtimeTaskId: string) {
    const row = this.database.prepare(
      "SELECT * FROM job_runs WHERE runtime_task_id=?",
    ).get(runtimeTaskId) as RunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  updateRun(
    runId: string,
    update: Partial<Pick<StoredRun,
      "status" | "runtimeTaskId" | "remoteRunId" | "completedAt" |
      "result" | "errorCode" | "readAt">>,
  ) {
    const current = this.getRun(runId);
    if (!current) return undefined;
    const next = { ...current, ...update };
    this.database.prepare(`
      UPDATE job_runs SET status=?,runtime_task_id=?,remote_run_id=?,
        completed_at=?,result=?,error_code=?,read_at=?
      WHERE run_id=?
    `).run(
      next.status, next.runtimeTaskId ?? null, next.remoteRunId ?? null,
      next.completedAt ?? null, next.result ?? null, next.errorCode ?? null,
      next.readAt ?? null, runId,
    );
    return this.getRun(runId);
  }

  history(jobUid: string, limit = 20) {
    const rows = this.database.prepare(`
      SELECT * FROM job_runs WHERE job_uid=?
      ORDER BY started_at DESC LIMIT ?
    `).all(jobUid, limit) as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  activeRuns(hostSessionId: string) {
    const rows = this.database.prepare(`
      SELECT * FROM job_runs
      WHERE host_session_id=? AND status IN ('claimed','running','cancelling')
      ORDER BY started_at
    `).all(hostSessionId) as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  unreadRuns(ownerBindingId: string) {
    const rows = this.database.prepare(`
      SELECT r.* FROM job_runs r
      JOIN jobs j ON j.uid=r.job_uid
      WHERE j.owner_binding_id=? AND r.read_at IS NULL
        AND r.status IN ('succeeded','failed','blocked','cancelled','interrupted','outcome_unknown')
      ORDER BY r.completed_at DESC LIMIT 20
    `).all(ownerBindingId) as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  inventoryVersion(ownerBindingId: string) {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(updated), '') AS updated FROM (
        SELECT updated_at AS updated FROM jobs WHERE owner_binding_id=?
        UNION ALL
        SELECT COALESCE(r.completed_at,r.started_at) AS updated
        FROM job_runs r JOIN jobs j ON j.uid=r.job_uid
        WHERE j.owner_binding_id=?
      )
    `).get(ownerBindingId, ownerBindingId) as { updated: string };
    return digest(row.updated);
  }
}
