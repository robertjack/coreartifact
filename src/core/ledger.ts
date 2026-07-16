// The ledger — SQLite schema v1 DDL, open/create.
//
// A disposable, rebuildable projection of the spool (schema.md Surface 1):
// deleting it and re-ingesting the spool must rebuild equivalent rows. NULL
// means ABSENT — the CHECK constraints below make fabrication a schema
// violation, not a code slip.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see paths.ts). A `declare module "node:sqlite"` shim would have to live
// in a script file with no top-level import/export to be accepted as a
// fresh ambient module rather than an augmentation of an (unresolvable)
// existing one — TS enforces this even for a never-before-seen specifier —
// and this issue owns no such file. So the two node imports below are
// `@ts-ignore`d at the import site and immediately re-typed through local
// interfaces that describe only the surface this file calls.

// @ts-ignore -- node:sqlite has no ambient types available in this sandbox
import { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";
// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { mkdirSync as mkdirSyncFn, existsSync as existsSyncFn, rmSync as rmSyncFn } from "node:fs";

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const DatabaseSync = DatabaseSyncCtor as unknown as new (path: string) => SqliteDatabase;
const mkdirSync = mkdirSyncFn as (path: string, options?: { recursive?: boolean }) => void;
const existsSync = existsSyncFn as (path: string) => boolean;
const rmSync = rmSyncFn as (path: string, options?: { force?: boolean }) => void;

// v2 (PRD-0002 schema.md): schema_version bumps 1 -> 2. This is a REBUILD
// TRIGGER, never a migration -- there is no ALTER path, this campaign or any
// other (schema.md "schema_version and the versioning stance"). Opening a
// ledger whose meta.schema_version isn't 2 deletes the file outright and
// recreates it empty; the next ingest rebuilds every projection from the
// spool, which is the only ground truth the ledger is allowed to assume.
export const SCHEMA_VERSION = 2;

// Verbatim from schema.md Surface 2 / this issue's spec — the DDL is fixed.
// `IF NOT EXISTS` is the only deviation (an implementation detail of
// open/create idempotency; it does not change table shape).
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  ingested_bytes INTEGER NOT NULL DEFAULT 0,
  lines_seen     INTEGER NOT NULL DEFAULT 0,
  last_ingest_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT PRIMARY KEY NOT NULL,
  repo_root      TEXT NOT NULL,
  worktree_path  TEXT,
  kind           TEXT CHECK (kind IN ('headless','interactive')),
  status         TEXT NOT NULL
                 CHECK (status IN ('open','closed-clean','closed-inferred')),
  sha_before     TEXT,
  sha_after      TEXT,
  started_at     TEXT NOT NULL,
  last_event_at  TEXT NOT NULL,
  ended_at       TEXT,
  -- +v2 cost/token facet: enrichment-derived from the transcript-at-path.
  -- All NULL = ABSENT (degradation law); tokens stored separately from
  -- cost_usd so "tokens present, cost absent" is expressible.
  tokens_input          INTEGER,
  tokens_output         INTEGER,
  tokens_cache_read     INTEGER,
  tokens_cache_creation INTEGER,
  cost_usd              REAL,
  model                 TEXT,
  cc_version            TEXT
);

CREATE TABLE IF NOT EXISTS events (
  line_no         INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  ts              TEXT NOT NULL,
  hook_event_name TEXT NOT NULL,
  prompt_id       TEXT,
  agent_id        TEXT,
  agent_type      TEXT,
  tool_use_id     TEXT,
  background_task_id TEXT,
  payload         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS footprint (
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);

-- +v2 checks: one row per check spool line. line_no is the check line's
-- spool ordinal (identity + idempotency anchor, same law as events).
CREATE TABLE IF NOT EXISTS checks (
  line_no    INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  name       TEXT NOT NULL,
  argv       TEXT NOT NULL,
  exit_code  INTEGER NOT NULL,
  output     TEXT NOT NULL,
  truncated  INTEGER NOT NULL CHECK (truncated IN (0,1)),
  session_id TEXT,
  bound_by   TEXT CHECK (bound_by IN ('single-open','explicit')),
  CHECK ((session_id IS NULL) = (bound_by IS NULL))
);

-- +v2 test_results: parser-derived test facet, one row per claimed command
-- event. No row = no parser claimed it (facet absent); a zero-count row is
-- a real zero.
CREATE TABLE IF NOT EXISTS test_results (
  line_no      INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL,
  parser       TEXT NOT NULL,
  passed       INTEGER NOT NULL,
  failed       INTEGER NOT NULL,
  skipped      INTEGER NOT NULL,
  duration_ms  INTEGER,
  failed_names TEXT NOT NULL
);

-- +v2 absences: the drift detector's per-session x facet ABSENT record.
CREATE TABLE IF NOT EXISTS absences (
  session_id TEXT NOT NULL,
  facet      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  PRIMARY KEY (session_id, facet)
);

CREATE INDEX IF NOT EXISTS idx_events_session       ON events       (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_checks_session       ON checks       (session_id);
CREATE INDEX IF NOT EXISTS idx_test_results_session ON test_results (session_id);
`;

export interface MetaRow {
  id: 1;
  schema_version: number;
  ingested_bytes: number;
  lines_seen: number;
  last_ingest_at: string | null;
}

export type SessionKind = "headless" | "interactive";
export type SessionStatus = "open" | "closed-clean" | "closed-inferred";

export interface SessionRow {
  session_id: string;
  repo_root: string;
  worktree_path: string | null;
  kind: SessionKind | null;
  status: SessionStatus;
  sha_before: string | null;
  sha_after: string | null;
  started_at: string;
  last_event_at: string;
  ended_at: string | null;
  // +v2 cost/token facet — NULL = ABSENT (degradation law), never fabricated.
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
  cost_usd: number | null;
  model: string | null;
  cc_version: string | null;
}

export interface EventRow {
  line_no: number;
  session_id: string;
  seq: number;
  ts: string;
  hook_event_name: string;
  prompt_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  tool_use_id: string | null;
  // +v2 promoted join key for the backgrounded-outcome resolution (Surface
  // 2d); NULL on every non-backgrounding, non-TaskOutput event.
  background_task_id: string | null;
  payload: string;
}

export interface FootprintRow {
  session_id: string;
  path: string;
}

// +v2 row readers — same style as SessionRow/EventRow above: typed shapes a
// caller queries directly via `db.prepare(...).all()`, not wrapped query
// functions (this module has never exported those for sessions/events
// either).
export type BoundBy = "single-open" | "explicit";

export interface CheckRow {
  line_no: number;
  ts: string;
  name: string;
  argv: string; // JSON array text, verbatim
  exit_code: number;
  output: string;
  truncated: 0 | 1;
  session_id: string | null;
  bound_by: BoundBy | null;
}

export interface TestResultRow {
  line_no: number;
  session_id: string;
  parser: string;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number | null; // NULL = parser could not extract it (ABSENT)
  failed_names: string; // JSON array text, '[]' when failed = 0
}

export interface AbsenceRow {
  session_id: string;
  facet: string;
  reason: string;
}

export interface LedgerHandle {
  db: SqliteDatabase;
  close(): void;
}

// Hand-rolled dirname: this file owns no shared path-join module, and
// pulling in node:path just for this one call isn't worth another
// unresolvable-import workaround (mirrors paths.ts's stance on sidestepping
// node:path).
function dirnameOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx <= 0 ? "/" : filePath.slice(0, idx);
}

// A ledger whose meta.schema_version isn't the current SCHEMA_VERSION is
// rebuilt from scratch: delete the file outright, never ALTER (schema.md
// "rebuild trigger, never a migration"). Any failure to read that verdict
// (missing meta table, corrupt file, unreadable row) is treated the same
// way as a stale version -- fail toward rebuilding, never toward silently
// keeping a schema this code doesn't understand.
function needsRebuild(dbPath: string): boolean {
  let probe: SqliteDatabase;
  try {
    probe = new DatabaseSync(dbPath);
  } catch {
    return true;
  }
  try {
    const metaTable = probe
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .all() as Array<{ name: string }>;
    if (metaTable.length === 0) return true;
    const metaRow = probe.prepare("SELECT schema_version FROM meta WHERE id = 1").get() as
      | { schema_version: number }
      | undefined;
    return metaRow?.schema_version !== SCHEMA_VERSION;
  } catch {
    return true;
  } finally {
    probe.close();
  }
}

// open/create: creates the parent `.coreartifact/` directory when absent
// rather than surfacing SQLite's opaque "unable to open database file" for
// what is, from the caller's perspective, ordinary first-run setup.
// Opening an already-initialized path at the current schema version is a
// no-op past table/row creation: `IF NOT EXISTS` and `INSERT OR IGNORE`
// make repeat opens idempotent. Opening a stale-version file rebuilds it
// (see needsRebuild) -- the spool is ground truth, so a from-scratch ledger
// with reset cursors is always safe to hand back.
export function openLedger(dbPath: string): LedgerHandle {
  mkdirSync(dirnameOf(dbPath), { recursive: true });
  if (existsSync(dbPath) && needsRebuild(dbPath)) {
    rmSync(dbPath, { force: true });
  }
  const db = new DatabaseSync(dbPath);
  // DatabaseSync defaults busy_timeout to 0, so a second process opening the
  // same ledger fails IMMEDIATELY with an opaque "database is locked" rather
  // than waiting for the writer to finish. Measured: 8 of 20 concurrent
  // openLedger calls died. This function's whole contract is that opening is
  // ordinary first-run setup — and PRD-0001 has `log` (which ingests) and the
  // dashboard reading the same ledger concurrently by design. Wait instead.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT OR IGNORE INTO meta (id, schema_version, ingested_bytes, lines_seen) VALUES (1, ?, 0, 0)"
  ).run(SCHEMA_VERSION);
  return {
    db,
    close: () => db.close(),
  };
}
