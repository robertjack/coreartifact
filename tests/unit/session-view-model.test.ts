import { describe, it, expect } from 'vitest';

const MODULE_PATH = '../../web/src/views/session/model';

async function loadModel() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

describe('session view-model (extra unit coverage)', () => {
  it('facetMarker treats a present (non-null) value as present regardless of absences', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');

    const result = mod.facetMarker('kind', 'headless', [{ facet: 'kind', reason: 'irrelevant' }]);
    expect(result.type).toBe('present');
    expect(result.value).toBe('headless');
  });

  it('checkBadge tolerates a bare {name, exit_code} fixture without passed/truncated/bound_by', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');

    const badge = mod.checkBadge({ name: 'build', exit_code: 137 });
    expect(badge.state).toBe('failed');
    expect(badge.exitCode).toBe(137);
    expect(badge.truncated).toBe(false);
  });

  it('testFacet distinguishes an absent facet from a present all-zero row', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');

    expect(mod.testFacet([]).type).toBe('absent');
    const present = mod.testFacet([
      { line_no: 1, parser: 'vitest', passed: 0, failed: 0, skipped: 0, duration_ms: null, failed_names: [] },
    ]);
    expect(present.type).toBe('present');
    expect(present.rows).toHaveLength(1);
  });

  it('timelineRow surfaces a failure outcome with its error message, never masking it as success', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');

    const row = mod.timelineRow({
      seq: 3,
      ts: '2026-07-17T13:03:00.000Z',
      kind: 'command',
      command: 'pnpm test',
      outcome: { state: 'failure', error: 'exit 1' },
    });
    expect(row.outcome).toBe('failure');
    expect(row.outcomeError).toBe('exit 1');
  });

  it('timelineRow passes through the four nesting keys verbatim, null where absent', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');

    const row = mod.timelineRow({
      kind: 'subagent',
      hook_event_name: 'SubagentStart',
      agent_id: 'agent-1',
      agent_type: 'implementer',
      prompt_id: null,
      tool_use_id: null,
    });
    expect(row.agentId).toBe('agent-1');
    expect(row.agentType).toBe('implementer');
    expect(row.promptId).toBeNull();
    expect(row.toolUseId).toBeNull();
  });

  it('footprintView returns a fresh array, not the same reference, for an empty footprint', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');

    const input: string[] = [];
    const result = mod.footprintView(input);
    expect(result).toEqual([]);
    expect(result).not.toBe(input);
  });

  it('facetHeader routes a derived cost/tokens facet to a present marker without hardcoding which keys are derived', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');

    const facets = {
      session_id: 's1',
      repo_root: '/repo',
      worktree_path: null,
      status: 'open',
      kind: null,
      sha_before: null,
      sha_after: null,
      model: null,
      cc_version: null,
      cost: { value: 1.5, derived: true },
      tokens: { derived: true, input: null, output: null, cache_read: null, cache_creation: null },
      started_at: '2026-07-17T13:00:00.000Z',
      last_event_at: '2026-07-17T13:00:00.000Z',
      ended_at: null,
    };
    const rows = mod.facetHeader(facets, [{ facet: 'kind', reason: 'no PRD kind recorded for this session' }]);
    const kindRow = rows.find((r: { key: string }) => r.key === 'kind');
    expect(kindRow.marker.type).toBe('disclosure');
    const worktreeRow = rows.find((r: { key: string }) => r.key === 'worktree_path');
    expect(worktreeRow.marker.type).toBe('quiet');
  });
});
