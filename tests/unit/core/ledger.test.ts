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

  it("creates the parent directory, schema v1 tables/index, and a single seeded meta row", () => {
    const dbPath = path.join(tmpDir, "nested", "dir", "ledger.db");
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);

    const handle = openLedger(dbPath);
    handle.close();

    expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    const state = inspect(dbPath);
    expect(state.tables).toEqual(["events", "footprint", "meta", "sessions"]);
    expect(state.indexes).toEqual(expect.arrayContaining(["idx_events_session"]));
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
});
