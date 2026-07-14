import { describe, it, expect } from "vitest";
import path from "node:path";
import { existsSync } from "node:fs";
import { SRC_CORE, mkTmpDir, tryImport } from "./helpers.js";

const LEDGER_MODULE = path.join(SRC_CORE, "ledger.ts");

// Imported through a non-literal specifier so a missing/incomplete
// @types/node "node:sqlite" declaration can't fail typecheck on our own
// inspection helper (distinct from the module under test, which is
// dynamic-imported for a different reason: it doesn't exist yet).
const SQLITE_MODULE_NAME = "node:sqlite";

async function openInspectionDb(dbPath: string, readOnly: boolean) {
  const sqlite: any = await import(SQLITE_MODULE_NAME);
  return new sqlite.DatabaseSync(dbPath, readOnly ? { readOnly: true } : undefined);
}

describe("ledger", () => {
  it("openLedger on a path with no database file creates the schema v1 tables meta, sessions, events and footprint plus the index on events(session_id, seq), and inserts the single meta row with schema_version 1, ingested_bytes 0 and lines_seen 0; opening the same path again returns the existing ledger without altering row counts", async () => {
    const mod = await tryImport(LEDGER_MODULE);
    if (!mod) throw new Error("not implemented yet: src/core/ledger.ts");
    const { openLedger } = mod;
    if (!openLedger) throw new Error("not implemented yet: openLedger export");

    const dir = mkTmpDir("coreartifact-ledger-");
    const dbPath = path.join(dir, "ledger.db");

    await openLedger(dbPath);
    expect(existsSync(dbPath)).toBe(true);

    const inspect = await openInspectionDb(dbPath, true);
    try {
      const tableNames = inspect
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row: any) => row.name);
      expect(tableNames).toEqual(
        expect.arrayContaining(["meta", "sessions", "events", "footprint"]),
      );

      const indexRows = inspect
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
        .all();
      expect(indexRows.some((r: any) => r.name === "idx_events_session")).toBe(true);

      const metaRows = inspect.prepare("SELECT * FROM meta").all();
      expect(metaRows.length).toBe(1);
      expect(metaRows[0]).toMatchObject({
        id: 1,
        schema_version: 1,
        ingested_bytes: 0,
        lines_seen: 0,
      });
    } finally {
      inspect.close();
    }

    // Opening the same path again must not alter row counts.
    await openLedger(dbPath);
    const reinspect = await openInspectionDb(dbPath, true);
    try {
      const metaRows = reinspect.prepare("SELECT * FROM meta").all();
      expect(metaRows.length).toBe(1);
      expect(metaRows[0]).toMatchObject({
        id: 1,
        schema_version: 1,
        ingested_bytes: 0,
        lines_seen: 0,
      });
      const sessionRows = reinspect.prepare("SELECT * FROM sessions").all();
      expect(sessionRows.length).toBe(0);
    } finally {
      reinspect.close();
    }
  });

  it("The ledger rejects a sessions row whose status is outside open, closed-clean and closed-inferred, and a sessions row whose kind is outside headless and interactive, while accepting a NULL kind", async () => {
    const mod = await tryImport(LEDGER_MODULE);
    if (!mod) throw new Error("not implemented yet: src/core/ledger.ts");
    const { openLedger } = mod;
    if (!openLedger) throw new Error("not implemented yet: openLedger export");

    const dir = mkTmpDir("coreartifact-ledger-");
    const dbPath = path.join(dir, "ledger.db");
    await openLedger(dbPath);

    const db = await openInspectionDb(dbPath, false);
    try {
      const insert = db.prepare(
        `INSERT INTO sessions (session_id, repo_root, worktree_path, kind, status, sha_before, sha_after, started_at, last_event_at, ended_at)
         VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?, NULL)`,
      );

      // session_id, repo_root, kind, status, started_at, last_event_at
      expect(() =>
        insert.run(
          "session-valid-null-kind",
          "/repo",
          null,
          "open",
          "2026-07-14T00:00:00.000Z",
          "2026-07-14T00:00:00.000Z",
        ),
      ).not.toThrow();

      expect(() =>
        insert.run(
          "session-bad-status",
          "/repo",
          "headless",
          "not-a-real-status",
          "2026-07-14T00:00:00.000Z",
          "2026-07-14T00:00:00.000Z",
        ),
      ).toThrow();

      expect(() =>
        insert.run(
          "session-bad-kind",
          "/repo",
          "not-a-real-kind",
          "open",
          "2026-07-14T00:00:00.000Z",
          "2026-07-14T00:00:00.000Z",
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("openLedger creates its parent directory when absent rather than throwing", async () => {
    const mod = await tryImport(LEDGER_MODULE);
    if (!mod) throw new Error("not implemented yet: src/core/ledger.ts");
    const { openLedger } = mod;
    if (!openLedger) throw new Error("not implemented yet: openLedger export");

    const dir = mkTmpDir("coreartifact-ledger-parent-");
    const dbPath = path.join(dir, "nested", "deeper", ".coreartifact", "ledger.db");

    await openLedger(dbPath);
    expect(existsSync(dbPath)).toBe(true);
  });
});
