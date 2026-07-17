// GET /api/overview[?repo=<root>] — the cross-repo union view (api.md
// Surface C, ISS-0028): the verified-delegation headline. Performs the
// union in application code via `walkRegisteredRepos` (the same
// ingest-on-read path `log`/`show` use) — never a second ingest
// implementation, never a cross-database SQL join.
import { readRegistry } from "../core/registry.js";
import { walkRegisteredRepos, type RepoStatus } from "../resolve-session.js";
import { TESTED_CLAUDE_CODE_RANGE } from "../doctor/version.js";
import {
  OVERVIEW_WINDOW_DAYS,
  LATEST_SESSIONS_LIMIT,
  computeWindowBounds,
  isSessionInWindow,
  classifySessionByChecks,
  isVersionInRange,
  type Classification,
} from "./classify.js";
import type { ApiHandler, ApiResult } from "./routes.js";

interface OverviewSessionRow {
  session_id: string;
  repo_root: string;
  worktree_path: string | null;
  kind: "headless" | "interactive" | null;
  status: string;
  started_at: string;
  cost_usd: number | null;
  cc_version: string | null;
}

interface CheckExitCodeRow {
  exit_code: number;
}

function fetchAllSessions(db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } }): OverviewSessionRow[] {
  return db
    .prepare(
      "SELECT session_id, repo_root, worktree_path, kind, status, started_at, cost_usd, cc_version FROM sessions",
    )
    .all() as OverviewSessionRow[];
}

function fetchCheckExitCodes(
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
  sessionId: string,
): number[] {
  return (db.prepare("SELECT exit_code FROM checks WHERE session_id = ?").all(sessionId) as CheckExitCodeRow[]).map(
    (row) => row.exit_code,
  );
}

// The local-clock ISO-8601 form with the server's own UTC offset (api.md
// "window": "a reader sees the operator's wall-clock") — distinct from the
// UTC-Z forms classify.ts's computeWindowBounds produces for the SQL-
// equivalent predicate.
function formatLocalIso(date: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetMins = pad(Math.abs(offsetMinutes) % 60);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${sign}${offsetHours}:${offsetMins}`;
}

interface SessionListEntry {
  session_id: string;
  repo_root: string;
  kind: "headless" | "interactive" | null;
  status: string;
  started_at: string;
  classification: Classification | null;
  cost: { value: number | null; derived: true };
}

interface DriftEntry {
  session_id: string;
  version: string;
  range: { min: string; max: string };
}

export const overviewHandler: ApiHandler = async (req) => {
  const url = new URL(req.url ?? "/api/overview", "http://coreartifact.internal");
  const repoParam = url.searchParams.get("repo");

  const registry = await readRegistry();

  if (repoParam !== null && !registry.has(repoParam)) {
    return {
      status: 404,
      body: { error: { code: "repo_not_registered", message: `repo not registered: ${repoParam}` } },
    };
  }

  const now = new Date();
  const window = computeWindowBounds(now.toISOString(), OVERVIEW_WINDOW_DAYS);

  let delegatedTotal = 0;
  let verified = 0;
  let failing = 0;
  let unverified = 0;
  let unknownKind = 0;

  let spendPresentUsd = 0;
  let costAbsentCount = 0;
  let kindHeadless = 0;
  let kindInteractive = 0;
  let kindUnknown = 0;
  let failingChecksTotal = 0;

  const sessions: SessionListEntry[] = [];
  const drift: DriftEntry[] = [];
  const repoStatuses: RepoStatus[] = [];

  const walkResult = await walkRegisteredRepos(
    ({ repoRoot, db }) => {
      const rows = fetchAllSessions(db).filter((row) => isSessionInWindow(row.started_at, window));

      for (const row of rows) {
        const exitCodes = fetchCheckExitCodes(db, row.session_id);
        const classification = row.kind === "headless" ? classifySessionByChecks(exitCodes) : null;

        if (row.kind === "headless") {
          delegatedTotal++;
          kindHeadless++;
          if (classification === "verified") verified++;
          else if (classification === "failing") failing++;
          else unverified++;
        } else if (row.kind === "interactive") {
          kindInteractive++;
        } else {
          kindUnknown++;
          unknownKind++;
        }

        if (row.cost_usd !== null) spendPresentUsd += row.cost_usd;
        else costAbsentCount++;

        failingChecksTotal += exitCodes.filter((code) => code !== 0).length;

        if (row.cc_version !== null && !isVersionInRange(row.cc_version, TESTED_CLAUDE_CODE_RANGE)) {
          drift.push({
            session_id: row.session_id,
            version: row.cc_version,
            range: { min: TESTED_CLAUDE_CODE_RANGE.min, max: TESTED_CLAUDE_CODE_RANGE.max },
          });
        }

        sessions.push({
          session_id: row.session_id,
          repo_root: row.repo_root,
          kind: row.kind,
          status: row.status,
          started_at: row.started_at,
          classification,
          cost: { value: row.cost_usd, derived: true },
        });
      }
    },
    { onlyRoot: repoParam ?? undefined },
  );
  repoStatuses.push(...walkResult.repoStatuses);

  sessions.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
  const total = sessions.length;
  const latest = sessions.slice(0, LATEST_SESSIONS_LIMIT);

  const result: ApiResult = {
    status: 200,
    body: {
      window: {
        start: formatLocalIso(new Date(window.startUtcZ)),
        end: formatLocalIso(now),
        days: OVERVIEW_WINDOW_DAYS,
      },
      kpi: {
        delegated_total: delegatedTotal,
        verified,
        failing,
        unverified,
        unknown_kind: unknownKind,
      },
      tiles: {
        spend_present_usd: spendPresentUsd,
        cost_absent_count: costAbsentCount,
        sessions_by_kind: { headless: kindHeadless, interactive: kindInteractive, unknown: kindUnknown },
        failing_checks: failingChecksTotal,
      },
      sessions: {
        latest,
        total,
      },
      repos: repoStatuses.map((entry) =>
        entry.status === "ok" ? { root: entry.root, status: "ok" } : { root: entry.root, status: "unreadable", reason: entry.reason },
      ),
      repos_skipped: registry.skipped,
      drift,
    },
  };
  return result;
};
