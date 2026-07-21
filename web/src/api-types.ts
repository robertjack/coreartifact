// Transcribed from docs/prd/PRD-0003-dashboard/api.md (the binding GET API
// contract). This is the single place the UI issues import the response
// shapes from; the server encodes the same shapes independently — the
// coupling is api.md, not a shared module across the tsc/vite boundary.

/** B2: a derived facet always carries its own `derived` flag as data. */
export interface DerivedCost {
  value: number | null;
  derived: true;
}

export interface DerivedTokens {
  derived: true;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_creation: number | null;
}

export type SessionKind = "headless" | "interactive" | null;
export type SessionStatus = "open" | "closed-clean" | "closed-inferred";
export type Classification = "verified" | "failing" | "unverified" | null;

export interface OverviewWindow {
  start: string;
  end: string;
  days: number;
}

export interface OverviewKpi {
  delegated_total: number;
  verified: number;
  failing: number;
  unverified: number;
  unknown_kind: number;
}

export interface OverviewTiles {
  spend_present_usd: number;
  cost_absent_count: number;
  sessions_by_kind: {
    headless: number;
    interactive: number;
    unknown: number;
  };
  failing_checks: number;
}

export interface OverviewSessionListEntry {
  session_id: string;
  repo_root: string;
  kind: SessionKind;
  status: SessionStatus;
  started_at: string;
  classification: Classification;
  cost: DerivedCost;
}

export interface OverviewSessions {
  latest: OverviewSessionListEntry[];
  total: number;
}

export type RepoStatusEntry =
  | { root: string; status: "ok" }
  | { root: string; status: "unreadable"; reason: string };

export interface DriftEntry {
  session_id: string;
  version: string;
  range: { min: string; max: string };
}

/** GET /api/overview[?repo=<root>] */
export interface OverviewResponse {
  window: OverviewWindow;
  kpi: OverviewKpi;
  tiles: OverviewTiles;
  sessions: OverviewSessions;
  repos: RepoStatusEntry[];
  repos_skipped: number;
  drift: DriftEntry[];
}

export interface SessionFacets {
  session_id: string;
  repo_root: string;
  worktree_path: string | null;
  status: SessionStatus;
  kind: SessionKind;
  sha_before: string | null;
  sha_after: string | null;
  model: string | null;
  cc_version: string | null;
  cost: DerivedCost;
  tokens: DerivedTokens;
  started_at: string;
  last_event_at: string;
  ended_at: string | null;
}

export interface SessionCheck {
  name: string;
  exit_code: number;
  passed: boolean;
  truncated: boolean;
  bound_by: string | null;
}

export interface SessionTestResult {
  line_no: number;
  parser: string;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number | null;
  failed_names: string[];
}

export type AbsenceFacetName = "cost" | "kind";

export interface Absence {
  facet: AbsenceFacetName;
  reason: string;
}

export type TimelineOutcome =
  | { state: "success" }
  | { state: "failure"; error: string }
  | { state: "absent" };

export interface TimelineTestResultsBadge {
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number | null;
  failed_names: string[];
}

interface TimelineEntryBase {
  seq: number;
  ts: string;
  prompt_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  tool_use_id: string | null;
}

export interface TimelineLifecycleEntry extends TimelineEntryBase {
  kind: "lifecycle";
  hook_event_name: string;
}

export interface TimelinePromptEntry extends TimelineEntryBase {
  kind: "prompt";
  prompt: string;
}

export interface TimelineCommandEntry extends TimelineEntryBase {
  kind: "command";
  command: string | null;
  duration_ms: number | null;
  outcome: TimelineOutcome;
  test_results: TimelineTestResultsBadge | null;
}

export interface TimelineSubagentEntry extends TimelineEntryBase {
  kind: "subagent";
  hook_event_name: string;
}

export type TimelineEntry =
  | TimelineLifecycleEntry
  | TimelinePromptEntry
  | TimelineCommandEntry
  | TimelineSubagentEntry;

/** GET /api/session/<id>[?repo=<root>] */
export interface SessionViewResponse {
  facets: SessionFacets;
  checks: SessionCheck[];
  test_results: SessionTestResult[];
  footprint: string[];
  absences: Absence[];
  timeline: TimelineEntry[];
}

/** Surface A: the one error body shape, everywhere. */
export interface ApiErrorResponse {
  error: {
    code:
      | "unknown_session"
      | "repo_not_registered"
      | "not_found"
      | "method_not_allowed"
      | "forbidden_host";
    message: string;
  };
}
