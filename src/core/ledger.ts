// The ledger — SQLite schema v1 DDL, open/create, typed row shapes.
//
// A disposable, rebuildable projection of the spool: deleting it and
// re-ingesting the spool must rebuild equivalent rows. NULL means ABSENT —
// the CHECK constraints below make fabrication a schema violation.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

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

export type SessionKind = 'headless' | 'interactive';
export type SessionStatus = 'open' | 'closed-clean' | 'closed-inferred';

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
  db: DatabaseSync;
  close(): void;
}

// open/create: creates the parent `.coreartifact/` directory when absent
// rather than surfacing SQLite's opaque "unable to open database file" for
// what is, from the caller's perspective, ordinary first-run setup.
export function openLedger(dbPath: string): LedgerHandle {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  db.exec(
    `INSERT OR IGNORE INTO meta (id, schema_version, ingested_bytes, lines_seen) VALUES (1, ${SCHEMA_VERSION}, 0, 0)`
  );
  return {
    db,
    close: () => db.close(),
  };
}
