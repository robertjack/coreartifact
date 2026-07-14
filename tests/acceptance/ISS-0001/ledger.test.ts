import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE_PATH = '../../../src/core/ledger';

async function loadLedgerModule() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

function tmpDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'coreartifact-ledger-'));
  return join(dir, 'ledger.db');
}

// Independent oracle: read the raw sqlite file with node's own driver,
// regardless of which driver the implementation used to create it.
function readSchemaObjects(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table','index')")
      .all() as Array<{ type: string; name: string }>;
    return rows;
  } finally {
    db.close();
  }
}

function readMetaRows(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM meta').all();
  } finally {
    db.close();
  }
}

describe('ledger', () => {
  it('openLedger on a path with no database file creates the schema v1 tables meta, sessions, events and footprint plus the index on events(session_id, seq), and inserts the single meta row with schema_version 1, ingested_bytes 0 and lines_seen 0; opening the same path again returns the existing ledger without altering row counts', async () => {
    const mod = await loadLedgerModule();
    if (!mod?.openLedger) throw new Error('not implemented yet');
    const openLedger = mod.openLedger;

    const dbPath = tmpDbPath();

    const first = await openLedger(dbPath);
    if (first && typeof (first as { close?: () => void }).close === 'function') {
      (first as { close: () => void }).close();
    }

    const objects = readSchemaObjects(dbPath);
    const tableNames = objects.filter((o) => o.type === 'table').map((o) => o.name).sort();
    expect(tableNames).toEqual(['events', 'footprint', 'meta', 'sessions']);

    const indexNames = objects.filter((o) => o.type === 'index').map((o) => o.name);
    expect(indexNames).toContain('idx_events_session');

    const metaRowsAfterFirstOpen = readMetaRows(dbPath) as Array<Record<string, unknown>>;
    expect(metaRowsAfterFirstOpen).toHaveLength(1);
    expect(metaRowsAfterFirstOpen[0]).toMatchObject({
      schema_version: 1,
      ingested_bytes: 0,
      lines_seen: 0,
    });

    const second = await openLedger(dbPath);
    if (second && typeof (second as { close?: () => void }).close === 'function') {
      (second as { close: () => void }).close();
    }

    const metaRowsAfterSecondOpen = readMetaRows(dbPath) as Array<Record<string, unknown>>;
    expect(metaRowsAfterSecondOpen).toHaveLength(1);
    expect(metaRowsAfterSecondOpen[0]).toMatchObject({
      schema_version: 1,
      ingested_bytes: 0,
      lines_seen: 0,
    });
  });

  it('The ledger rejects a sessions row whose status is outside open, closed-clean and closed-inferred, and a sessions row whose kind is outside headless and interactive, while accepting a NULL kind', async () => {
    const mod = await loadLedgerModule();
    if (!mod?.openLedger) throw new Error('not implemented yet');
    const openLedger = mod.openLedger;

    const dbPath = tmpDbPath();
    const handle = await openLedger(dbPath);
    if (handle && typeof (handle as { close?: () => void }).close === 'function') {
      (handle as { close: () => void }).close();
    }

    const db = new DatabaseSync(dbPath);
    try {
      const insertSession = (sessionId: string, status: string, kind: string | null) => {
        db.prepare(
          `INSERT INTO sessions (session_id, repo_root, kind, status, started_at, last_event_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(sessionId, '/tmp/repo', kind, status, '2026-07-14T10:00:00.000Z', '2026-07-14T10:00:00.000Z');
      };

      expect(() => insertSession('bad-status', 'not-a-real-status', 'headless')).toThrow();
      expect(() => insertSession('bad-kind', 'open', 'not-a-real-kind')).toThrow();
      expect(() => insertSession('null-kind-ok', 'open', null)).not.toThrow();

      const row = db
        .prepare('SELECT session_id, kind, status FROM sessions WHERE session_id = ?')
        .get('null-kind-ok') as { session_id: string; kind: string | null; status: string };
      expect(row.kind).toBeNull();
      expect(row.status).toBe('open');
    } finally {
      db.close();
    }
  });
});
