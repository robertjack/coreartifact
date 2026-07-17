// `coreartifact log` — union every registered repo's sessions into one
// flat, honest timeline (docs/issues/ISS-0007.md). This command stays
// thin: for each registered ledger, trigger ingest (the ingest slice's
// mechanism), read back its sessions/events/footprint, and hand
// everything to the renderer (src/render/log.ts) this issue owns. `log`
// never re-derives a fact the ledger already computed.
//
// `log` is a GLOBAL command (docs/issues/ISS-0007.md amendment,
// 2026-07-14): it reads the registry, not `cwd`, and must run from
// ANYWHERE — git repo or not — exiting 0 either way. It also unions
// across every registered repo, and a registry can point at a root the
// user has since moved, deleted, or whose ledger is corrupt (the registry
// is append-only, v1 has no unregister — PRD-0002). Both facts push every
// per-repo failure mode into its own try/catch, mirroring
// `readRegistry`'s own "a damaged registry never takes down a command"
// totality one level up: one bad entry folds to a named warning, the
// healthy repos still union and print.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:sqlite import below is `@ts-ignore`d at
// the import site and re-typed through a local interface.

import { readRegistry } from "../../core/registry.js";
import { findWorktreeGaps } from "../../worktree-gap.js";
import { walkRegisteredRepos, type RepoVisit } from "../../resolve-session.js";
import {
  renderSessionLines,
  renderIngestReport,
  renderWorktreeGapWarnings,
  renderNoRegisteredRepos,
  type SessionLineInput,
} from "../../render/log.js";

type SqliteDatabase = RepoVisit["db"];

declare const process: {
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
};

interface SessionSummaryRow {
  session_id: string;
  status: string;
  kind: "headless" | "interactive" | null;
  started_at: string;
  cost_usd: number | null;
}

interface EventCandidateRow {
  payload: string;
  tool_use_id: string;
}

// Command count comes from the events table, never re-derived from the
// spool (spec "What log does") — the distinct Bash tool_use_ids this
// session's events name. tool_name lives only in the decoded payload, not
// as its own column, so this reads and parses payload same as the
// footprint derivation does.
function countBashCommands(db: SqliteDatabase, sessionId: string): number {
  const rows = db
    .prepare("SELECT payload, tool_use_id FROM events WHERE session_id = ? AND tool_use_id IS NOT NULL")
    .all(sessionId) as EventCandidateRow[];
  const bashToolUseIds = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as { tool_name?: unknown };
      if (parsed.tool_name === "Bash") bashToolUseIds.add(row.tool_use_id);
    } catch {
      // malformed payload: not a countable Bash event, never fabricated
    }
  }
  return bashToolUseIds.size;
}

// Footprint count from the footprint table (spec "What log does") — the
// table's own primary key (session_id, path) already dedupes, so this is
// a plain row count, never re-derived.
function countFootprint(db: SqliteDatabase, sessionId: string): number {
  const row = db.prepare("SELECT COUNT(*) as n FROM footprint WHERE session_id = ?").get(sessionId) as {
    n: number;
  };
  return row.n;
}

interface CheckExitCodeRow {
  exit_code: number;
}

// ISS-0024 R12: the checks column — pass/fail derived from exit code 0,
// summarized per session. `WHERE session_id = ?` naturally excludes
// standalone checks (session_id NULL) — they belong to no session line in
// v1 (spec "Render (R12)"), not silently dropped, just out of this column's
// scope; they stay reachable in the ledger's own `checks` table.
function countChecks(db: SqliteDatabase, sessionId: string): { pass: number; fail: number } {
  const rows = db
    .prepare("SELECT exit_code FROM checks WHERE session_id = ?")
    .all(sessionId) as CheckExitCodeRow[];
  let pass = 0;
  let fail = 0;
  for (const row of rows) {
    if (row.exit_code === 0) pass++;
    else fail++;
  }
  return { pass, fail };
}

export async function logCommand(): Promise<number> {
  // No cwd/git-repo requirement here (S2 fix, 2026-07-14 review finding):
  // `log` reads the GLOBAL registry, not cwd. It must exit 0 from any
  // directory, git repo or not — the "log run outside any registered repo
  // exits 0 and says so" criterion means literally this, run from
  // anywhere.
  const registry = await readRegistry();
  const registeredRoots = [...registry.keys()];

  if (registeredRoots.length === 0) {
    process.stdout.write(`${renderNoRegisteredRepos()}\n`);
    return 0;
  }

  const sessionLines: SessionLineInput[] = [];
  const reportLines: string[] = [];
  const gapWarningLines: string[] = [];

  // Step 2 (spec): ingest each registered ledger's spool, then read back its
  // sessions — never skip a repo just because it isn't the one the command
  // was run from (the union across repos this issue adds). The walk itself
  // (src/resolve-session.ts, shared with `show` per ISS-0012) already
  // applies the degradation law to the loop: an unreachable or errored repo
  // folds to a named warning rather than aborting the union before the
  // reachable repos' sessions print (2026-07-14 review finding S1).
  const { warnings } = await walkRegisteredRepos(({ repoRoot, db, report }) => {
    reportLines.push(renderIngestReport(report, repoRoot));

    const gaps = findWorktreeGaps(repoRoot);
    if (gaps.length > 0) {
      gapWarningLines.push(renderWorktreeGapWarnings(gaps));
    }

    const sessions = db
      .prepare("SELECT session_id, status, kind, started_at, cost_usd FROM sessions ORDER BY started_at")
      .all() as SessionSummaryRow[];

    for (const session of sessions) {
      const checks = countChecks(db, session.session_id);
      sessionLines.push({
        sessionId: session.session_id,
        repoRoot,
        status: session.status,
        kind: session.kind,
        startedAt: session.started_at,
        commandCount: countBashCommands(db, session.session_id),
        footprintCount: countFootprint(db, session.session_id),
        costUsd: session.cost_usd,
        checksPass: checks.pass,
        checksFail: checks.fail,
      });
    }
  });

  const output: string[] = [renderSessionLines(sessionLines), ...reportLines, ...gapWarningLines, ...warnings];
  process.stdout.write(`${output.join("\n")}\n`);
  return 0;
}
