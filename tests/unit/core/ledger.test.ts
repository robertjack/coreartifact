import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../../../src/core/ledger.js';

function tmpDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'coreartifact-ledger-unit-'));
  return join(dir, 'ledger.db');
}

describe('ledger (unit)', () => {
  it('accepts a fully-populated events row with promoted nesting keys and a footprint row, dedupes footprint by (session_id, path)', () => {
    const handle = openLedger(tmpDbPath());
    try {
      handle.db.exec(
        `INSERT INTO sessions (session_id, repo_root, kind, status, started_at, last_event_at)
         VALUES ('s1', '/tmp/repo', NULL, 'open', '2026-07-14T10:00:00.000Z', '2026-07-14T10:00:00.000Z')`
      );
      handle.db
        .prepare(
          `INSERT INTO events (line_no, session_id, seq, ts, hook_event_name, prompt_id, agent_id, agent_type, tool_use_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(1, 's1', 1, '2026-07-14T10:00:00.000Z', 'PreToolUse', null, 'agent-1', 'explore', 'tool-1', '{"a":1}');

      handle.db.prepare(`INSERT INTO footprint (session_id, path) VALUES (?, ?)`).run('s1', 'src/index.ts');
      expect(() =>
        handle.db.prepare(`INSERT INTO footprint (session_id, path) VALUES (?, ?)`).run('s1', 'src/index.ts')
      ).toThrow();

      const event = handle.db.prepare('SELECT * FROM events WHERE line_no = 1').get() as Record<string, unknown>;
      expect(event.agent_id).toBe('agent-1');
      expect(event.prompt_id).toBeNull();

      const footprintCount = handle.db.prepare('SELECT COUNT(*) as n FROM footprint WHERE session_id = ?').get('s1') as {
        n: number;
      };
      expect(footprintCount.n).toBe(1);
    } finally {
      handle.close();
    }
  });

  it('rejects a duplicate line_no on re-insert (the ON CONFLICT dedupe anchor)', () => {
    const handle = openLedger(tmpDbPath());
    try {
      handle.db.exec(
        `INSERT INTO sessions (session_id, repo_root, status, started_at, last_event_at)
         VALUES ('s1', '/tmp/repo', 'open', '2026-07-14T10:00:00.000Z', '2026-07-14T10:00:00.000Z')`
      );
      const insertEvent = () =>
        handle.db
          .prepare(
            `INSERT INTO events (line_no, session_id, seq, ts, hook_event_name, payload)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(1, 's1', 1, '2026-07-14T10:00:00.000Z', 'PreToolUse', '{}');

      insertEvent();
      expect(() => insertEvent()).toThrow();
    } finally {
      handle.close();
    }
  });

  it('creates its parent directory when opening a path several levels deep', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreartifact-ledger-unit-parent-'));
    const dbPath = join(dir, 'a', 'b', 'c', 'ledger.db');
    const handle = openLedger(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      handle.close();
    }
  });

  // The equivalent acceptance test (tests/acceptance/ISS-0001/ledger.test.ts)
  // cannot currently exercise this: its inspection helper calls
  // `new DatabaseSync(path, undefined)` for the non-readonly case, and
  // node:sqlite on this Node build throws "the 'options' argument must be
  // an object" for an explicit `undefined` (vs. simply omitting the
  // argument) — a test-harness bug, independent of this module, reproduced
  // directly against node:sqlite outside of vitest. This test exercises the
  // same CHECK-constraint contract by omitting the options argument instead.
  it('rejects a sessions row whose status or kind falls outside the allowed CHECK values, while accepting a NULL kind', () => {
    const handle = openLedger(tmpDbPath());
    try {
      const insert = handle.db.prepare(
        `INSERT INTO sessions (session_id, repo_root, worktree_path, kind, status, sha_before, sha_after, started_at, last_event_at, ended_at)
         VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?, NULL)`
      );

      expect(() =>
        insert.run('s-null-kind', '/repo', null, 'open', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')
      ).not.toThrow();

      expect(() =>
        insert.run(
          's-bad-status',
          '/repo',
          'headless',
          'not-a-real-status',
          '2026-07-14T00:00:00.000Z',
          '2026-07-14T00:00:00.000Z'
        )
      ).toThrow();

      expect(() =>
        insert.run(
          's-bad-kind',
          '/repo',
          'not-a-real-kind',
          'open',
          '2026-07-14T00:00:00.000Z',
          '2026-07-14T00:00:00.000Z'
        )
      ).toThrow();
    } finally {
      handle.close();
    }
  });
});
