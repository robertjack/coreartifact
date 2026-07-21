import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openLedger, SCHEMA_VERSION, LedgerPathIsDirectoryError } from "../../../src/core/ledger.js";

// Spawns a real second process that opens `dbPath`, takes `BEGIN EXCLUSIVE`
// (a real, cross-process SQLite lock -- not a same-process/synchronous stand-
// in, which cannot contend: gotchas.md #4), writes `signalPath` once the lock
// is held, then holds it for `holdMs` before rolling back and exiting. Returns
// a promise that resolves once the signal file appears (i.e. once the lock is
// confirmed held), and a handle to await full child exit later.
function spawnLockHolder(dbPath: string, signalPath: string, holdMs: number) {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const fs = require("node:fs");
    const [, dbPath, signalPath, holdMsRaw] = process.argv;
    const holdMs = Number(holdMsRaw);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
    db.prepare("UPDATE meta SET lines_seen = lines_seen WHERE id = 1").run();
    fs.writeFileSync(signalPath, "locked");
    const ia = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(ia, 0, 0, holdMs);
    db.exec("ROLLBACK");
    db.close();
  `;
  const child = spawn(process.execPath, ["-e", script, "--", dbPath, signalPath, String(holdMs)], {
    stdio: "inherit",
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const locked = new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (fs.existsSync(signalPath)) return resolve();
      if (Date.now() > deadline) return reject(new Error("lock holder never signaled"));
      setTimeout(poll, 20);
    };
    poll();
  });
  return { locked, exited };
}

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

  it(
    "S1: a concurrent writer's real cross-process lock on a VALID v2 ledger must never cause a delete -- openLedger throws instead of returning a wiped ledger",
    { timeout: 30000 },
    async () => {
      const dbPath = path.join(tmpDir, "ledger.db");
      const signalPath = path.join(tmpDir, "lock.signal");

      // Seed a valid, distinguishable v2 ledger: nonzero cursor values so a
      // silent wipe (reset to 0) is unmistakable from a thrown error.
      const seedHandle = openLedger(dbPath);
      seedHandle.db.exec("UPDATE meta SET ingested_bytes = 4096, lines_seen = 12 WHERE id = 1");
      seedHandle.close();
      const statBefore = fs.statSync(dbPath);

      // holdMs deliberately exceeds openLedger's busy_timeout (5000ms) so the
      // probe is guaranteed to still be contending, not merely unlucky. The
      // margin is 7s, not the original 1s: on a saturated CI runner (first
      // seen macos-15, CI run #1, 2026-07-21) signal-detection and scheduling
      // latency ate the 1s margin — the child released inside the parent's
      // busy_timeout window and openLedger wrongly succeeded.
      const holder = spawnLockHolder(dbPath, signalPath, 12000);
      await holder.locked;

      let thrown: unknown;
      try {
        openLedger(dbPath);
      } catch (err) {
        thrown = err;
      }

      await holder.exited;

      expect(thrown).toBeDefined();
      expect(thrown).toBeInstanceOf(Error);

      // The file must be untouched: same inode (ino unchanged) and the
      // seeded meta row intact, not a freshly recreated empty ledger.
      const statAfter = fs.statSync(dbPath);
      expect(statAfter.ino).toBe(statBefore.ino);
      const raw = new DatabaseSync(dbPath);
      try {
        const meta = raw.prepare("SELECT schema_version, ingested_bytes, lines_seen FROM meta").get() as any;
        expect(meta.schema_version).toBe(SCHEMA_VERSION);
        expect(meta.ingested_bytes).toBe(4096);
        expect(meta.lines_seen).toBe(12);
      } finally {
        raw.close();
      }
    }
  );

  it("S3: openLedger on a path that is a directory throws a named LedgerPathIsDirectoryError, not raw EISDIR", () => {
    const dbPath = path.join(tmpDir, "ledger.db");
    fs.mkdirSync(dbPath);

    let thrown: unknown;
    try {
      openLedger(dbPath);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    // Named, not the raw fs EISDIR ("ERR_FS_EISDIR" / generic "Error").
    expect((thrown as Error).name).toBe("LedgerPathIsDirectoryError");
    expect(thrown).toBeInstanceOf(LedgerPathIsDirectoryError);
  });
});
