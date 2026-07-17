import { describe, it, expect } from 'vitest';

// Module under test does not exist yet (implementer creates it). Loaded via
// a caught dynamic import through a variable specifier so this file collects
// and every criterion below fails red at the assertion, not at import time.
const MODULE_PATH = '../../../web/src/views/session/model';

async function loadSessionModel() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

describe('session view-model (ISS-0031)', () => {
  it('The session view-model maps a facets.cost object with derived true to a rendered figure carrying the derived marker, and maps a facets.kind of null that has a matching absences entry to a disclosure chip carrying the recorded reason rather than a dash.', async () => {
    const mod = await loadSessionModel();
    if (!mod) throw new Error('web/src/views/session/model.ts is not implemented yet');

    const facets = { cost: { value: 4.5, derived: true } };
    const costResult = mod.costFacet(facets);
    expect(costResult.derived).toBe(true);
    expect(costResult.value).toBe(4.5);

    const absences = [{ facet: 'kind', reason: 'no PRD kind recorded for this session' }];
    const kindResult = mod.facetMarker('kind', null, absences);
    expect(kindResult.type).toBe('disclosure');
    expect(kindResult.reason).toBe('no PRD kind recorded for this session');
  });

  it('The session view-model maps a self-describing nullable such as a null worktree_path or a null sha_before to a quiet marker and never to a disclosure chip, keeping loud reasoned-ABSENT distinct from quiet self-describing null.', async () => {
    const mod = await loadSessionModel();
    if (!mod) throw new Error('web/src/views/session/model.ts is not implemented yet');

    const worktreeResult = mod.facetMarker('worktree_path', null, []);
    expect(worktreeResult.type).toBe('quiet');
    expect(worktreeResult.type).not.toBe('disclosure');

    const shaResult = mod.facetMarker('sha_before', null, []);
    expect(shaResult.type).toBe('quiet');
    expect(shaResult.type).not.toBe('disclosure');
  });

  it('The session view-model maps a checks entry to a badge showing the name and a passed or failed state derived from exit_code, and maps a test_results empty array to an ABSENT test facet distinct from a present zero-count row.', async () => {
    const mod = await loadSessionModel();
    if (!mod) throw new Error('web/src/views/session/model.ts is not implemented yet');

    const passingCheck = { name: 'typecheck', exit_code: 0 };
    const failingCheck = { name: 'lint', exit_code: 1 };
    const passBadge = mod.checkBadge(passingCheck);
    expect(passBadge.name).toBe('typecheck');
    expect(passBadge.state).toBe('passed');
    const failBadge = mod.checkBadge(failingCheck);
    expect(failBadge.name).toBe('lint');
    expect(failBadge.state).toBe('failed');

    const absentTest = mod.testFacet([]);
    expect(absentTest.type).toBe('absent');

    const zeroCountTest = mod.testFacet([{ passed: 0, failed: 0, skipped: 0 }]);
    expect(zeroCountTest.type).toBe('present');
    expect(zeroCountTest.type).not.toBe('absent');
  });

  it('The session view-model maps each timeline entry to a row preserving spool order and surfacing the entry kind, and renders a command entry whose outcome state is absent with the explicit absent marker rather than as success.', async () => {
    const mod = await loadSessionModel();
    if (!mod) throw new Error('web/src/views/session/model.ts is not implemented yet');

    const entries = [
      { kind: 'user_message' },
      { kind: 'command', outcome: 'success' },
      { kind: 'command', outcome: 'absent' },
    ];
    const rows = entries.map((entry) => mod.timelineRow(entry));

    expect(rows.map((row) => row.kind)).toEqual(['user_message', 'command', 'command']);
    expect(rows[2].outcome).toBe('absent');
    expect(rows[2].outcome).not.toBe('success');
  });

  it('The session view-model maps an empty footprint array to a real empty set rather than an ABSENT marker.', async () => {
    const mod = await loadSessionModel();
    if (!mod) throw new Error('web/src/views/session/model.ts is not implemented yet');

    const result = mod.footprintView([]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });
});
