import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { tryImport } from './helpers.js';

// Guessed at the conventional location for the persistence module; the
// module does not exist yet. If this path is wrong, loadLedgerModule()
// throws "not implemented yet" below, which is still a red assertion
// failure (never a collection error).
const LEDGER_MODULE_PATH = '../../../src/core/ledger.js';

async function loadLedgerModule(): Promise<any> {
  const mod = await tryImport(LEDGER_MODULE_PATH);
  if (!mod || typeof mod.openLedger !== 'function') {
    throw new Error(`not implemented yet: ${LEDGER_MODULE_PATH}#openLedger`);
  }
  return mod;
}

function inspectLedger(dbPath: string) {
  const raw = new DatabaseSync(dbPath);
  try {
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as any[]).map(
      (r) => r.name as string
    );
    const indexes = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as any[]).map(
      (r) => r.name as string
    );
    const metaRows = raw.prepare('SELECT * FROM meta').all() as any[];
    const sessionCount = (raw.prepare('SELECT COUNT(*) as c FROM sessions').get() as any).c as number;
    const eventCount = (raw.prepare('SELECT COUNT(*) as c FROM events').get() as any).c as number;
    const footprintCount = (raw.prepare('SELECT COUNT(*) as c FROM footprint').get() as any).c as number;
    return { tables, indexes, metaRows, sessionCount, eventCount, footprintCount };
  } finally {
    raw.close();
  }
}

describe('ISS-0010 ledger', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iss0010-ledger-'));
  });

  it('openLedger on a path with no database file creates the parent directory if absent, creates the schema tables meta, sessions, events and footprint plus the index on events(session_id, seq), and inserts the single meta row with the current schema_version, ingested_bytes 0 and lines_seen 0; opening the same path again returns the existing ledger without altering row counts.', async () => {
    const mod = await loadLedgerModule();
    const dbPath = path.join(tmpDir, 'nested', 'dir', 'ledger.db');

    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);

    await mod.openLedger(dbPath);

    expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    const first = inspectLedger(dbPath);
    expect(first.tables).toEqual(expect.arrayContaining(['meta', 'sessions', 'events', 'footprint']));
    expect(first.indexes).toEqual(expect.arrayContaining(['idx_events_session']));
    expect(first.metaRows).toHaveLength(1);
    expect(first.metaRows[0]).toMatchObject({
      id: 1,
      schema_version: 2, // operator amendment 2026-07-16: ISS-0013 bumps schema v1->v2 (drop-and-reingest law); the literal was over-pinned, the criterion is unchanged
      ingested_bytes: 0,
      lines_seen: 0,
    });
    expect(first.sessionCount).toBe(0);
    expect(first.eventCount).toBe(0);
    expect(first.footprintCount).toBe(0);

    // Opening the same path again must not alter row counts.
    await mod.openLedger(dbPath);

    const second = inspectLedger(dbPath);
    expect(second.metaRows).toHaveLength(1);
    expect(second.metaRows[0]).toMatchObject({
      id: 1,
      schema_version: 2, // operator amendment 2026-07-16: ISS-0013 bumps schema v1->v2 (drop-and-reingest law); the literal was over-pinned, the criterion is unchanged
      ingested_bytes: 0,
      lines_seen: 0,
    });
    expect(second.sessionCount).toBe(0);
    expect(second.eventCount).toBe(0);
    expect(second.footprintCount).toBe(0);
  });

  it('The ledger rejects a sessions row whose status is outside open, closed-clean and closed-inferred, and a sessions row whose kind is outside headless and interactive, while accepting a NULL kind.', async () => {
    const mod = await loadLedgerModule();
    const dbPath = path.join(tmpDir, 'ledger.db');
    await mod.openLedger(dbPath);

    const raw = new DatabaseSync(dbPath);
    try {
      const insert = (sessionId: string, status: string | null, kind: string | null) => {
        const ts = new Date(0).toISOString();
        raw
          .prepare(
            `INSERT INTO sessions (session_id, repo_root, worktree_path, kind, status, sha_before, sha_after, started_at, last_event_at, ended_at)
             VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?, NULL)`
          )
          .run(sessionId, '/repo', kind, status, ts, ts);
      };

      expect(() => insert('bad-status', 'not-a-real-status', 'headless')).toThrow();
      expect(() => insert('bad-kind', 'open', 'not-a-real-kind')).toThrow();
      expect(() => insert('null-kind-ok', 'open', null)).not.toThrow();

      const row = raw.prepare('SELECT * FROM sessions WHERE session_id = ?').get('null-kind-ok') as any;
      expect(row.kind).toBeNull();
      expect(row.status).toBe('open');

      const count = (raw.prepare('SELECT COUNT(*) as c FROM sessions').get() as any).c as number;
      expect(count).toBe(1);
    } finally {
      raw.close();
    }
  });
});
