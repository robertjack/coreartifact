import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../../../src/core/ledger';

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
      // A duplicate (session_id, path) pair must be rejected by the primary key.
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
});
