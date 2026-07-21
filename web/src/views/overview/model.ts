// Pure, DOM-free view-model functions for the overview page (ISS-0030).
// Consumed by web/src/views/Overview.tsx and exercised directly by
// tests/unit/overview-view-model.test.ts. No React import here.

import type {
  DriftEntry,
  OverviewKpi,
  OverviewSessionListEntry,
  OverviewTiles,
  RepoStatusEntry,
} from "../../api-types";

export function headline(kpi: Pick<OverviewKpi, "verified" | "delegated_total">): string {
  return `${kpi.verified} of ${kpi.delegated_total}`;
}

export interface BarSegment {
  key: "verified" | "failing" | "unverified";
  widthPct: number;
}

export interface BarSegments {
  segments: BarSegment[];
  empty: boolean;
}

/** Largest-remainder rounding so the three widths always sum to exactly 100. */
export function barSegments(
  kpi: Pick<OverviewKpi, "verified" | "failing" | "unverified" | "delegated_total">,
): BarSegments {
  const total = kpi.delegated_total;
  if (!total) {
    return { segments: [], empty: true };
  }

  const counts: Array<{ key: BarSegment["key"]; count: number }> = [
    { key: "verified", count: kpi.verified },
    { key: "failing", count: kpi.failing },
    { key: "unverified", count: kpi.unverified },
  ];

  const raw = counts.map((c) => (c.count / total) * 100);
  const floors = raw.map(Math.floor);
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);

  const order = raw
    .map((v, i) => ({ i, frac: v - floors[i] }))
    .sort((a, b) => b.frac - a.frac);

  const widths = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    widths[i] += 1;
    remainder -= 1;
  }

  return {
    empty: false,
    segments: counts.map((c, i) => ({ key: c.key, widthPct: widths[i] })),
  };
}

export interface SpendTile {
  valueUsd: number;
  derived: true;
  absentNote: string | null;
}

export function spendTile(tiles: Pick<OverviewTiles, "spend_present_usd" | "cost_absent_count">): SpendTile {
  return {
    valueUsd: tiles.spend_present_usd,
    derived: true,
    absentNote: tiles.cost_absent_count > 0 ? `unknown for ${tiles.cost_absent_count} sessions` : null,
  };
}

export interface RepoRow {
  visible: boolean;
  reason: string | null;
}

export function repoRow(entry: RepoStatusEntry): RepoRow {
  if (entry.status === "unreadable") {
    return { visible: true, reason: entry.reason };
  }
  return { visible: false, reason: null };
}

export interface ReposSkippedNotice {
  visible: boolean;
  count: number;
}

export function reposSkippedNotice(count: number): ReposSkippedNotice {
  return { visible: count > 0, count };
}

export interface DriftBannerEntry {
  session: string;
  version: string;
  range: string;
}

type LooseDriftEntry =
  | DriftEntry
  | { session: string; version: string; range: string };

function driftRangeToString(range: DriftEntry["range"] | string): string {
  return typeof range === "string" ? range : `${range.min}-${range.max}`;
}

export function driftBanner(drift: LooseDriftEntry[]): DriftBannerEntry[] | null {
  if (!drift || drift.length === 0) return null;
  return drift.map((d) => ({
    session: "session" in d ? d.session : d.session_id,
    version: d.version,
    range: driftRangeToString(d.range),
  }));
}

export interface SessionRow {
  sessionId: string;
  repoRoot: string;
  href: string;
  kind: OverviewSessionListEntry["kind"] | undefined;
  status: OverviewSessionListEntry["status"] | undefined;
  startedAt: string | undefined;
  cost: OverviewSessionListEntry["cost"] | undefined;
  badge: OverviewSessionListEntry["classification"];
}

export function sessionRow(
  entry: Pick<OverviewSessionListEntry, "session_id" | "repo_root" | "classification"> &
    Partial<OverviewSessionListEntry>,
): SessionRow {
  return {
    sessionId: entry.session_id,
    repoRoot: entry.repo_root,
    href: `/session/${encodeURIComponent(entry.session_id)}?repo=${encodeURIComponent(entry.repo_root)}`,
    kind: entry.kind,
    status: entry.status,
    startedAt: entry.started_at,
    cost: entry.cost,
    badge: entry.classification,
  };
}

// Repo picker (post-launch 0.1.1): options for scoping the overview to one
// registered root via the API's existing `?repo=` parameter (api.md
// Surface C — the contract shipped with the filter; the UI simply never
// grew the control). Options derive from response `repos` entries the
// caller has ACCUMULATED across loads: a scoped response may carry only
// the selected root, so the picker's memory must outlive any one response.
export interface RepoPickerOption {
  value: string;
  label: string;
}

export function repoPickerOptions(roots: readonly string[]): RepoPickerOption[] {
  const unique = [...new Set(roots)].sort();
  const basename = (root: string): string => root.split("/").filter(Boolean).at(-1) ?? root;
  const counts = new Map<string, number>();
  for (const root of unique) {
    const b = basename(root);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  // A duplicated basename (two repos named "app") falls back to the full
  // root as its label — never ambiguous, never truncated dishonestly.
  return unique.map((root) => ({
    value: root,
    label: (counts.get(basename(root)) ?? 0) > 1 ? root : basename(root),
  }));
}

export function overviewUrl(repo: string | null): string {
  return repo === null ? "/api/overview" : `/api/overview?repo=${encodeURIComponent(repo)}`;
}
