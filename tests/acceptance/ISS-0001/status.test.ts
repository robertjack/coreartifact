import { describe, it, expect } from 'vitest';

const MODULE_PATH = '../../../src/core/status';

async function loadStatusModule() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

describe('status', () => {
  it('deriveStatus returns closed-clean when an end timestamp is present, closed-inferred when there is no end timestamp and the last event is older than the staleness threshold constant of 12 hours, and open when there is no end timestamp and the last event is inside that threshold; recomputing with a newly supplied end timestamp returns closed-clean for an input that previously derived closed-inferred', async () => {
    const mod = await loadStatusModule();
    if (!mod?.deriveStatus) throw new Error('not implemented yet');
    const deriveStatus = mod.deriveStatus;

    const now = new Date('2026-07-14T12:00:00.000Z');
    const justInsideThreshold = new Date(now.getTime() - (TWELVE_HOURS_MS - 60_000)).toISOString();
    const justOutsideThreshold = new Date(now.getTime() - (TWELVE_HOURS_MS + 60_000)).toISOString();

    const closedClean = deriveStatus({
      endedAt: '2026-07-14T11:00:00.000Z',
      lastEventAt: justOutsideThreshold,
      now,
    });
    expect(closedClean).toBe('closed-clean');

    const closedInferred = deriveStatus({
      endedAt: null,
      lastEventAt: justOutsideThreshold,
      now,
    });
    expect(closedInferred).toBe('closed-inferred');

    const open = deriveStatus({
      endedAt: null,
      lastEventAt: justInsideThreshold,
      now,
    });
    expect(open).toBe('open');

    const recomputedWithLateEndTimestamp = deriveStatus({
      endedAt: '2026-07-14T11:59:00.000Z',
      lastEventAt: justOutsideThreshold,
      now,
    });
    expect(recomputedWithLateEndTimestamp).toBe('closed-clean');
  });
});
