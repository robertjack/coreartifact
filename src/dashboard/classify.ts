// Pure classification and window math for GET /api/overview (api.md
// Surface C, ISS-0028) — no I/O, so it is the seam
// tests/unit/dashboard-classify.test.ts exercises directly: the three-way
// partition, the window boundary (inclusive vs excluded), and the semver
// drift comparison.

// Named constants (api.md "Named constants") that belong to the window/
// session-list math this module owns — one place, reused by
// src/dashboard/overview.ts.
export const OVERVIEW_WINDOW_DAYS = 7;
export const LATEST_SESSIONS_LIMIT = 50;

export type Classification = "verified" | "failing" | "unverified";

// The three-way partition (api.md "kpi"): a headless session with zero
// bound checks is unverified; one failing bound check makes it failing even
// alongside passing checks; otherwise (at least one check, none failing) it
// is verified.
export function classifySessionByChecks(exitCodes: number[]): Classification {
  if (exitCodes.length === 0) return "unverified";
  return exitCodes.some((code) => code !== 0) ? "failing" : "verified";
}

export interface WindowBounds {
  startUtcZ: string;
  endUtcZ: string;
}

// `endUtcZ` is the request instant (UTC-Z ISO-8601); `startUtcZ` is exactly
// `days` before it — a rolling span, not a calendar boundary.
export function computeWindowBounds(endUtcZ: string, days: number): WindowBounds {
  const end = new Date(endUtcZ);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { startUtcZ: start.toISOString(), endUtcZ: end.toISOString() };
}

// Inclusive at both ends: a session started_at exactly at window.start or
// window.end is IN the window; one millisecond earlier than window.start is
// excluded (the SQL predicate's own `>=`/`<=`, api.md "SQL semantics").
export function isSessionInWindow(startedAtUtcZ: string, window: WindowBounds): boolean {
  const started = new Date(startedAtUtcZ).getTime();
  return started >= new Date(window.startUtcZ).getTime() && started <= new Date(window.endUtcZ).getTime();
}

export interface VersionRange {
  min: string;
  max: string;
}

// Numeric, dotted-segment comparison — never lexicographic ("2.1.9" vs
// "2.1.10" is the canonical trap a string compare gets wrong).
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const na = partsA[i] ?? 0;
    const nb = partsB[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// Inclusive at both ends of `range` (the range's own min/max are in-range).
export function isVersionInRange(version: string, range: VersionRange): boolean {
  return compareVersions(version, range.min) >= 0 && compareVersions(version, range.max) <= 0;
}
