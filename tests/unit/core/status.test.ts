import { describe, it, expect } from 'vitest';
import { deriveStatus, STALENESS_THRESHOLD_MS } from '../../../src/core/status.js';

describe('status (unit)', () => {
  it('exports the staleness threshold as exactly 12 hours', () => {
    expect(STALENESS_THRESHOLD_MS).toBe(12 * 60 * 60 * 1000);
  });

  it('endedAt takes precedence over staleness even when the last event is ancient', () => {
    const now = '2026-07-14T12:00:00.000Z';
    const status = deriveStatus({
      endedAt: '2026-01-01T00:00:00.000Z',
      lastEventAt: '2020-01-01T00:00:00.000Z',
      now,
    });
    expect(status).toBe('closed-clean');
  });

  it('a session with no events yet older than one second reads open, not inferred', () => {
    const now = '2026-07-14T12:00:00.000Z';
    const status = deriveStatus({
      endedAt: null,
      lastEventAt: new Date(Date.parse(now) - 1000).toISOString(),
      now,
    });
    expect(status).toBe('open');
  });

  it('is exactly at the threshold boundary: not yet stale', () => {
    const now = '2026-07-14T12:00:00.000Z';
    const status = deriveStatus({
      endedAt: null,
      lastEventAt: new Date(Date.parse(now) - STALENESS_THRESHOLD_MS).toISOString(),
      now,
    });
    expect(status).toBe('open');
  });
});
