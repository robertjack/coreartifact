import { describe, test, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// @ts-ignore -- node:sqlite has no ambient types available in this sandbox (see src/core/ledger.ts)
import { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";

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

// The ledger module (src/core/ledger.ts) already exists at schema v1 for
// PRD-0001 (openLedger(dbPath): { db, close() }, synchronous) — this issue
// upgrades its DDL and rebuild-trigger behavior in place, so this import is
// NOT wrapped in a try/catch dynamic import the way a brand-new module would
// be: the module exists today, only `openLedger`'s v2 behavior is new.
import { openLedger } from "../../../src/core/ledger.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "iss13-ledger-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
});

function tableNames(db: SqliteDatabase): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

function indexNames(db: SqliteDatabase): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

function columnInfo(db: SqliteDatabase, table: string): Array<{ name: string; notnull: number }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
}

// The real v1 DDL from src/core/ledger.ts (SCHEMA_VERSION = 1), hand-built
// here per this issue's test-harness contract: "the rebuild-trigger test
// builds a real v1-shaped SQLite file... by hand in the test."
const V1_SCHEMA_SQL = `
CREATE TABLE meta (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  ingested_bytes INTEGER NOT NULL DEFAULT 0,
  lines_seen     INTEGER NOT NULL DEFAULT 0,
  last_ingest_at TEXT
);

CREATE TABLE sessions (
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

CREATE TABLE events (
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

CREATE TABLE footprint (
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);

CREATE INDEX idx_events_session ON events (session_id, seq);
`;

describe("ISS-0013 ledger schema v2", () => {
  test(
    "Opening a fresh ledger creates schema v2: the meta row carries schema_version 2, the sessions table accepts the five nullable cost and token columns plus model and cc_version, the events table accepts a nullable background_task_id, and the checks, test_results and absences tables exist with their session indexes; opening the same path again alters no row counts.",
    () => {
      const dbPath = path.join(makeTmpDir(), "ledger.db");

      const handle = openLedger(dbPath);
      try {
        const metaRow = handle.db.prepare("SELECT schema_version FROM meta").get() as {
          schema_version: number;
        };
        expect(metaRow.schema_version).toBe(2);

        const sessionCols = columnInfo(handle.db, "sessions");
        const sessionColNames = sessionCols.map((c) => c.name);
        for (const col of [
          "tokens_input",
          "tokens_output",
          "tokens_cache_read",
          "tokens_cache_creation",
          "cost_usd",
          "model",
          "cc_version",
        ]) {
          expect(sessionColNames).toContain(col);
          const info = sessionCols.find((c) => c.name === col);
          expect(info?.notnull).toBe(0);
        }

        const eventCols = columnInfo(handle.db, "events");
        const backgroundTaskIdCol = eventCols.find((c) => c.name === "background_task_id");
        expect(backgroundTaskIdCol).toBeDefined();
        expect(backgroundTaskIdCol?.notnull).toBe(0);

        const tables = tableNames(handle.db);
        expect(tables).toContain("checks");
        expect(tables).toContain("test_results");
        expect(tables).toContain("absences");

        const indexes = indexNames(handle.db);
        expect(indexes).toContain("idx_checks_session");
        expect(indexes).toContain("idx_test_results_session");

        // Seed a marker row so re-opening the same path can be checked for
        // row-count stability below.
        handle.db
          .prepare(
            `INSERT INTO checks (line_no, ts, name, argv, exit_code, output, truncated, session_id, bound_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(1, "2026-07-16T00:00:00.000Z", "lint", '["pnpm","lint"]', 0, "ok", 0, null, null);
      } finally {
        handle.close();
      }

      const secondHandle = openLedger(dbPath);
      try {
        const metaRow2 = secondHandle.db.prepare("SELECT schema_version FROM meta").get() as {
          schema_version: number;
        };
        expect(metaRow2.schema_version).toBe(2);
        const checksCount = secondHandle.db.prepare("SELECT COUNT(*) as n FROM checks").get() as { n: number };
        expect(checksCount.n).toBe(1);
      } finally {
        secondHandle.close();
      }
    },
  );

  test(
    "Opening a ledger whose meta row carries schema_version 1 (or any value other than 2) deletes and recreates it as an empty schema v2 ledger with reset ingest cursors, so the next ingest rebuilds everything from the spool — never an ALTER, never a partial upgrade.",
    () => {
      const dbPath = path.join(makeTmpDir(), "ledger-v1.db");

      const v1db = new DatabaseSync(dbPath);
      v1db.exec(V1_SCHEMA_SQL);
      v1db
        .prepare("INSERT INTO meta (id, schema_version, ingested_bytes, lines_seen) VALUES (1, 1, 4096, 12)")
        .run();
      v1db
        .prepare(
          `INSERT INTO sessions (session_id, repo_root, status, started_at, last_event_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("sess-old", "/repo", "open", "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z");
      v1db.close();

      const handle = openLedger(dbPath);
      try {
        const metaRow = handle.db
          .prepare("SELECT schema_version, ingested_bytes, lines_seen FROM meta")
          .get() as { schema_version: number; ingested_bytes: number; lines_seen: number };
        expect(metaRow.schema_version).toBe(2);
        expect(metaRow.ingested_bytes).toBe(0);
        expect(metaRow.lines_seen).toBe(0);

        const tables = tableNames(handle.db);
        expect(tables).toContain("checks");
        expect(tables).toContain("test_results");
        expect(tables).toContain("absences");

        const sessionsCount = handle.db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number };
        expect(sessionsCount.n).toBe(0);
      } finally {
        handle.close();
      }
    },
  );

  test(
    "The checks table rejects a row whose truncated flag is outside 0 and 1, a row whose bound_by is outside single-open and explicit, and a row where exactly one of session_id and bound_by is NULL — binding is all-or-nothing.",
    () => {
      const dbPath = path.join(makeTmpDir(), "ledger-constraints.db");
      const handle = openLedger(dbPath);
      try {
        const insertChecksRow = (row: {
          line_no: number;
          truncated: number;
          session_id: string | null;
          bound_by: string | null;
        }) => {
          handle.db
            .prepare(
              `INSERT INTO checks (line_no, ts, name, argv, exit_code, output, truncated, session_id, bound_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              row.line_no,
              "2026-07-16T00:00:00.000Z",
              "lint",
              '["pnpm","lint"]',
              0,
              "ok",
              row.truncated,
              row.session_id,
              row.bound_by,
            );
        };

        expect(() => insertChecksRow({ line_no: 1, truncated: 2, session_id: null, bound_by: null })).toThrow();
        expect(() =>
          insertChecksRow({ line_no: 2, truncated: 0, session_id: "sess-x", bound_by: "sometimes" }), // operator amendment 2026-07-16 (review S2): session_id set so ONLY the enum CHECK can reject — the null form also violated all-or-nothing, making this row unable to isolate the enum clause
        ).toThrow();
        expect(() =>
          insertChecksRow({ line_no: 3, truncated: 0, session_id: "sess-1", bound_by: null }),
        ).toThrow();
        expect(() =>
          insertChecksRow({ line_no: 4, truncated: 0, session_id: null, bound_by: "explicit" }),
        ).toThrow();

        // control: a fully valid all-or-nothing bound row is accepted.
        expect(() =>
          insertChecksRow({ line_no: 5, truncated: 0, session_id: "sess-1", bound_by: "explicit" }),
        ).not.toThrow();
      } finally {
        handle.close();
      }
    },
  );
});
