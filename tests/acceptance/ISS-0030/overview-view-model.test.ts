import { describe, it, expect } from 'vitest';

const MODULE_PATH = '../../../web/src/views/overview/model';

async function loadModel() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

describe('overview view-model', () => {
  it('The overview view-model derives the headline string 1 of 3 from a kpi with verified 1 and delegated_total 3, and derives 0 of 0 from an empty-registry kpi with delegated_total 0 without producing NaN.', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');
    const { headline } = mod;
    if (!headline) throw new Error('not implemented yet');

    const kpi = { verified: 1, failing: 1, unverified: 1, delegated_total: 3 };
    expect(headline(kpi)).toBe('1 of 3');

    const emptyKpi = { verified: 0, failing: 0, unverified: 0, delegated_total: 0 };
    const result = headline(emptyKpi);
    expect(result).toBe('0 of 0');
    expect(result).not.toContain('NaN');
  });

  it('The overview view-model derives the three-way segmented-bar segment widths from kpi.verified, kpi.failing, and kpi.unverified so that the three widths are proportional to those counts and sum to the whole for a non-zero delegated_total, and renders an explicit empty state for a zero delegated_total.', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');
    const { barSegments } = mod;
    if (!barSegments) throw new Error('not implemented yet');

    const kpi = { verified: 1, failing: 1, unverified: 2, delegated_total: 4 };
    const result = barSegments(kpi);
    if (!result) throw new Error('not implemented yet');
    const segments = result.segments;
    expect(Array.isArray(segments)).toBe(true);

    const verifiedSeg = segments.find((s) => s.key === 'verified');
    const failingSeg = segments.find((s) => s.key === 'failing');
    const unverifiedSeg = segments.find((s) => s.key === 'unverified');
    if (!verifiedSeg || !failingSeg || !unverifiedSeg) throw new Error('not implemented yet');

    expect(verifiedSeg.widthPct).toBe(25);
    expect(failingSeg.widthPct).toBe(25);
    expect(unverifiedSeg.widthPct).toBe(50);
    expect(verifiedSeg.widthPct + failingSeg.widthPct + unverifiedSeg.widthPct).toBe(100);

    const zeroKpi = { verified: 0, failing: 0, unverified: 0, delegated_total: 0 };
    const zeroResult = barSegments(zeroKpi);
    if (!zeroResult) throw new Error('not implemented yet');
    expect(zeroResult.empty).toBe(true);
    expect(zeroResult.segments).toEqual([]);
  });

  it('The overview view-model renders the spend tile from tiles.spend_present_usd with the derived marker and, when tiles.cost_absent_count is greater than zero, surfaces the count of cost-unknown sessions rather than presenting the sum as a complete figure.', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');
    const { spendTile } = mod;
    if (!spendTile) throw new Error('not implemented yet');

    const tiles = { spend_present_usd: 12.5, cost_absent_count: 2 };
    const tile = spendTile(tiles);
    if (!tile) throw new Error('not implemented yet');
    expect(tile.valueUsd).toBe(12.5);
    expect(tile.derived).toBe(true);
    expect(tile.absentNote).toBe('unknown for 2 sessions');
  });

  it('The overview view-model maps a repos entry with status unreadable to a visible degraded row carrying its reason string, and maps repos_skipped greater than zero to a visible surfaced count.', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');
    const { repoRow, reposSkippedNotice } = mod;
    if (!repoRow || !reposSkippedNotice) throw new Error('not implemented yet');

    const entry = { root: '/repo/a', status: 'unreadable', reason: 'permission denied reading .git' };
    const row = repoRow(entry);
    if (!row) throw new Error('not implemented yet');
    expect(row.visible).toBe(true);
    expect(row.reason).toBe('permission denied reading .git');

    const notice = reposSkippedNotice(3);
    if (!notice) throw new Error('not implemented yet');
    expect(notice.visible).toBe(true);
    expect(notice.count).toBe(3);
  });

  it('The overview view-model maps a drift array entry to a visible banner naming the session, its version, and the tested range, and renders no banner when the drift array is empty.', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');
    const { driftBanner } = mod;
    if (!driftBanner) throw new Error('not implemented yet');

    const drift = [{ session: 'sess-123', version: '2.1.212', range: '2.1.208-2.1.211' }];
    const banners = driftBanner(drift);
    if (!banners) throw new Error('not implemented yet');
    expect(Array.isArray(banners)).toBe(true);
    expect(banners.length).toBe(1);
    expect(banners[0].session).toBe('sess-123');
    expect(banners[0].version).toBe('2.1.212');
    expect(banners[0].range).toBe('2.1.208-2.1.211');

    const noDrift = driftBanner([]);
    expect(noDrift).toBeNull();
  });

  it('The overview view-model maps a session-list entry whose classification is null (interactive or unknown-kind) to a row that omits the verified/failing/unverified badge rather than defaulting it to any of the three states.', async () => {
    const mod = await loadModel();
    if (!mod) throw new Error('not implemented yet');
    const { sessionRow } = mod;
    if (!sessionRow) throw new Error('not implemented yet');

    const entry = {
      session_id: 'sess-456',
      repo_root: '/repo/b',
      classification: null,
      kind: 'interactive',
    };
    const row = sessionRow(entry);
    if (!row) throw new Error('not implemented yet');
    expect(row.badge == null).toBe(true);
    expect(['verified', 'failing', 'unverified']).not.toContain(row.badge);
  });
});
