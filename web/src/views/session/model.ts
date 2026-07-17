// Pure, DOM-free view-model functions for the session view (ISS-0031).
// Consumed by web/src/views/Session.tsx and exercised directly by
// tests/acceptance/ISS-0031/session-view-model.test.ts and
// tests/unit/session-view-model.test.ts. No React import here.

import type {
  Absence,
  DerivedCost,
  DerivedTokens,
  SessionCheck,
  SessionFacets,
  SessionTestResult,
  TimelineEntry,
  TimelineOutcome,
  TimelineTestResultsBadge,
} from "../../api-types";

/** api.md B2: derived facets always carry their own `.derived` flag as data. */
export function costFacet(facets: { cost: DerivedCost }): DerivedCost {
  return facets.cost;
}

export function tokensFacet(facets: { tokens: DerivedTokens }): DerivedTokens {
  return facets.tokens;
}

export type FacetMarker =
  | { type: "disclosure"; reason: string; value: null }
  | { type: "quiet"; value: null }
  | { type: "present"; value: unknown };

/**
 * A `null` facet is either loud reasoned-ABSENT (a matching `absences` row —
 * the disclosure chip) or a quiet self-describing nullable (no row, a plain
 * dash). Never inferred from the facet name — only from whether a reason was
 * actually recorded (api.md B1.3).
 */
export function facetMarker(
  facetName: string,
  value: unknown,
  absences: Pick<Absence, "facet" | "reason">[],
): FacetMarker {
  if (value !== null) {
    return { type: "present", value };
  }
  const absence = absences.find((a) => a.facet === facetName);
  if (absence) {
    return { type: "disclosure", reason: absence.reason, value: null };
  }
  return { type: "quiet", value: null };
}

export interface CheckBadgeView {
  name: string;
  state: "passed" | "failed";
  exitCode: number;
  truncated: boolean;
}

/** `passed` is the derived render of `exit_code === 0` (api.md "checks"). */
export function checkBadge(check: Pick<SessionCheck, "name" | "exit_code"> & Partial<SessionCheck>): CheckBadgeView {
  return {
    name: check.name,
    state: check.exit_code === 0 ? "passed" : "failed",
    exitCode: check.exit_code,
    truncated: check.truncated ?? false,
  };
}

export type TestFacetView =
  | { type: "absent" }
  | { type: "present"; rows: SessionTestResult[] };

/** Empty array = ABSENT (no command claimed); a present row can still be all-zero. */
export function testFacet(rows: SessionTestResult[]): TestFacetView {
  if (rows.length === 0) {
    return { type: "absent" };
  }
  return { type: "present", rows };
}

/** `[]` is a real empty set, never ABSENT (api.md "footprint"). */
export function footprintView(footprint: string[]): string[] {
  return footprint.slice();
}

export interface TimelineRowView {
  seq: number | undefined;
  ts: string | undefined;
  kind: string;
  hookEventName: string | null;
  prompt: string | null;
  command: string | null;
  durationMs: number | null;
  outcome: "success" | "failure" | "absent" | null;
  outcomeError: string | null;
  testResults: TimelineTestResultsBadge | null;
  promptId: string | null;
  agentId: string | null;
  agentType: string | null;
  toolUseId: string | null;
}

function resolveOutcome(raw: TimelineOutcome | string | undefined): {
  outcome: "success" | "failure" | "absent" | null;
  outcomeError: string | null;
} {
  if (raw == null) {
    return { outcome: null, outcomeError: null };
  }
  if (typeof raw === "string") {
    return { outcome: raw as "success" | "failure" | "absent", outcomeError: null };
  }
  return {
    outcome: raw.state,
    outcomeError: raw.state === "failure" ? raw.error : null,
  };
}

/**
 * Flat, spool-order rows. A command's three-state `outcome` is surfaced
 * faithfully — `absent` (e.g. a backgrounded command with no resolving
 * TaskOutput) is never collapsed into `success` (api.md "timeline").
 */
export function timelineRow(entry: Partial<TimelineEntry> & Record<string, unknown>): TimelineRowView {
  const { outcome, outcomeError } = resolveOutcome(entry.outcome as TimelineOutcome | string | undefined);
  return {
    seq: entry.seq as number | undefined,
    ts: entry.ts as string | undefined,
    kind: entry.kind as string,
    hookEventName: (entry.hook_event_name as string | undefined) ?? null,
    prompt: (entry.prompt as string | undefined) ?? null,
    command: (entry.command as string | null | undefined) ?? null,
    durationMs: (entry.duration_ms as number | null | undefined) ?? null,
    outcome,
    outcomeError,
    testResults: (entry.test_results as TimelineTestResultsBadge | null | undefined) ?? null,
    promptId: (entry.prompt_id as string | null | undefined) ?? null,
    agentId: (entry.agent_id as string | null | undefined) ?? null,
    agentType: (entry.agent_type as string | null | undefined) ?? null,
    toolUseId: (entry.tool_use_id as string | null | undefined) ?? null,
  };
}

export interface FacetHeaderRow {
  key: keyof SessionFacets;
  marker: FacetMarker;
}

const SELF_DESCRIBING_NULLABLES: ReadonlySet<keyof SessionFacets> = new Set([
  "sha_before",
  "sha_after",
  "ended_at",
  "worktree_path",
  "model",
  "cc_version",
]);

/** Builds the facet-header rows, reading `.derived`/`absences` generically — never hardcoding which facets are derived (api.md B2). */
export function facetHeader(facets: SessionFacets, absences: Absence[]): FacetHeaderRow[] {
  const keys: (keyof SessionFacets)[] = [
    "session_id",
    "repo_root",
    "worktree_path",
    "status",
    "kind",
    "sha_before",
    "sha_after",
    "model",
    "cc_version",
    "started_at",
    "last_event_at",
    "ended_at",
  ];
  return keys.map((key) => {
    const value = facets[key];
    if (value && typeof value === "object" && "derived" in value) {
      return { key, marker: { type: "present", value } };
    }
    return { key, marker: facetMarker(key, value as unknown, absences) };
  });
}

export function isSelfDescribingNullable(facetName: keyof SessionFacets): boolean {
  return SELF_DESCRIBING_NULLABLES.has(facetName);
}
