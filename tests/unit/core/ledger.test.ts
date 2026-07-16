import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openLedger, SCHEMA_VERSION } from "../../../src/core/ledger.js";

function inspect(dbPath: string) {
  const raw = new DatabaseSync(dbPath);
  try {
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as any[]).map(
      (r) => r.name as string
    );
    const indexes = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as any[]
    ).map((r) => r.name as string);
    const metaRows = raw.prepare("SELECT * FROM meta").all() as any[];
    const sessionCount = (raw.prepare("SELECT COUNT(*) as c FROM sessions").get() as any).c as number;
    const eventCount = (raw.prepare("SELECT COUNT(*) as c FROM events").get() as any).c as number;
    const footprintCount = (raw.prepare("SELECT COUNT(*) as c FROM footprint").get() as any).c as number;
    return { tables, indexes, metaRows, sessionCount, eventCount, footprintCount };
  } finally {
    raw.close();
  }
}

describe("openLedger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss0010-ledger-unit-"));
  });

  it("creates the parent directory, schema v2 tables/index, and a single seeded meta row", () => {
    const dbPath = path.join(tmpDir, "nested", "dir", "ledger.db");
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);

    const handle = openLedger(dbPath);
    handle.close();

    expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    const state = inspect(dbPath);
    expect(state.tables).toEqual([
      "absences",
      "checks",
      "events",
      "footprint",
      "meta",
      "sessions",
      "test_results",
    ]);
    expect(state.indexes).toEqual(
      expect.arrayContaining(["idx_events_session", "idx_checks_session", "idx_test_results_session"])
    );
    expect(state.metaRows).toHaveLength(1);
    expect(state.metaRows[0]).toMatchObject({
      id: 1,
      schema_version: SCHEMA_VERSION,
      ingested_bytes: 0,
      lines_seen: 0,
    });
    expect(state.sessionCount).toBe(0);
    expect(state.eventCount).toBe(0);
    expect(state.footprintCount).toBe(0);
  });

  it("opening an already-initialized path is a no-op past the first create: row counts never change", () => {
    const dbPath = path.join(tmpDir, "ledger.db");

    openLedger(dbPath).close();
    const first = inspect(dbPath);

    openLedger(dbPath).close();
    const second = inspect(dbPath);

    expect(second.metaRows).toEqual(first.metaRows);
    expect(second.sessionCount).toBe(first.sessionCount);
    expect(second.eventCount).toBe(first.eventCount);
    expect(second.footprintCount).toBe(first.footprintCount);
  });

  it("rejects a sessions row with a status outside the allowed set", () => {
    const dbPath = path.join(tmpDir, "ledger.db");
    const handle = openLedger(dbPath);
    const ts = new Date(0).toISOString();

    expect(() =>
      handle.db
        .prepare(
          `INSERT INTO sessions (session_id, repo_root, worktree_path, kind, status, sha_before, sha_after, started_at, last_event_at, ended_at)
           VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?, NULL)`
        )
        .run("bad-status", "/repo", "headless", "not-a-real-status", ts, ts)
    ).toThrow();

    handle.close();
  });

  it("rejects a sessions row with a kind outside the allowed set, but accepts a NULL kind", () => {
    const dbPath = path.join(tmpDir, "ledger.db");
    const handle = openLedger(dbPath);
    const ts = new Date(0).toISOString();

    const insert = (sessionId: string, kind: string | null) =>
      handle.db
        .prepare(
          `INSERT INTO sessions (session_id, repo_root, worktree_path, kind, status, sha_before, sha_after, started_at, last_event_at, ended_at)
           VALUES (?, ?, NULL, ?, 'open', NULL, NULL, ?, ?, NULL)`
        )
        .run(sessionId, "/repo", kind, ts, ts);

    expect(() => insert("bad-kind", "not-a-real-kind")).toThrow();
    expect(() => insert("null-kind-ok", null)).not.toThrow();

    const row = handle.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("null-kind-ok") as any;
    expect(row.kind).toBeNull();

    handle.close();
  });

  it("v2: sessions accepts the cost/token columns as NULL by default, and events accepts a nullable background_task_id", () => {
    const dbPath = path.join(tmpDir, "ledger.db");
    const handle = openLedger(dbPath);
    const ts = new Date(0).toISOString();

    handle.db
      .prepare(
        `INSERT INTO sessions (session_id, repo_root, worktree_path, kind, status, sha_before, sha_after, started_at, last_event_at, ended_at)
         VALUES (?, ?, NULL, NULL, 'open', NULL, NULL, ?, ?, NULL)`
      )
      .run("sess-1", "/repo", ts, ts);
    const session = handle.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-1") as any;
    expect(session.tokens_input).toBeNull();
    expect(session.tokens_output).toBeNull();
    expect(session.tokens_cache_read).toBeNull();
    expect(session.tokens_cache_creation).toBeNull();
    expect(session.cost_usd).toBeNull();
    expect(session.model).toBeNull();
    expect(session.cc_version).toBeNull();

    handle.db
      .prepare(
        `INSERT INTO events (line_no, session_id, seq, ts, hook_event_name, background_task_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(1, "sess-1", 1, ts, "PostToolUse", "task-abc", "{}");
    const event = handle.db.prepare("SELECT background_task_id FROM events WHERE line_no = 1").get() as any;
    expect(event.background_task_id).toBe("task-abc");

    handle.close();
  });

  it("v2: opening a stale schema_version file deletes and rebuilds it fresh, resetting ingest cursors", () => {
    const dbPath = path.join(tmpDir, "ledger.db");
    const ts = new Date(0).toISOString();

    const v1db = new DatabaseSync(dbPath);
    v1db.exec(`
      CREATE TABLE meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        ingested_bytes INTEGER NOT NULL DEFAULT 0,
        lines_seen INTEGER NOT NULL DEFAULT 0,
        last_ingest_at TEXT
      );
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY NOT NULL, repo_root TEXT NOT NULL, started_at TEXT NOT NULL, last_event_at TEXT NOT NULL, status TEXT NOT NULL);
    `);
    v1db.prepare("INSERT INTO meta (id, schema_version, ingested_bytes, lines_seen) VALUES (1, 1, 999, 7)").run();
    v1db.prepare("INSERT INTO sessions (session_id, repo_root, started_at, last_event_at, status) VALUES (?, ?, ?, ?, ?)").run(
      "old",
      "/repo",
      ts,
      ts,
      "open"
    );
    v1db.close();

    const handle = openLedger(dbPath);
    const meta = handle.db.prepare("SELECT schema_version, ingested_bytes, lines_seen FROM meta").get() as any;
    expect(meta.schema_version).toBe(SCHEMA_VERSION);
    expect(meta.ingested_bytes).toBe(0);
    expect(meta.lines_seen).toBe(0);
    const sessionCount = (handle.db.prepare("SELECT COUNT(*) as c FROM sessions").get() as any).c;
    expect(sessionCount).toBe(0);

    handle.close();
  });
});
