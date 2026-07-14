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
import { mkdirSync as mkdirSyncFn } from "node:fs";

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

export const SCHEMA_VERSION = 1;

// Verbatim from schema.md Surface 1 / this issue's spec — the DDL is fixed.
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
  ended_at       TEXT
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
  payload         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS footprint (
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, seq);
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
  payload: string;
}

export interface FootprintRow {
  session_id: string;
  path: string;
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

// open/create: creates the parent `.coreartifact/` directory when absent
// rather than surfacing SQLite's opaque "unable to open database file" for
// what is, from the caller's perspective, ordinary first-run setup.
// Opening an already-initialized path is a no-op past table/row creation:
// `IF NOT EXISTS` and `INSERT OR IGNORE` make repeat opens idempotent.
export function openLedger(dbPath: string): LedgerHandle {
  mkdirSync(dirnameOf(dbPath), { recursive: true });
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
