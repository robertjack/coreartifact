// The `log` renderer — one line per session, unioned across repos, honest
// about gaps (docs/issues/ISS-0007.md). Pure formatting only: every field
// (counts, status, kind) is computed by the caller (src/cli/commands/log.ts)
// from the ledger; this module never touches SQLite or the spool.
//
// This is also the absent-marker rendering seam `show` will reuse later —
// `kind` is the one field on the session line that can itself be ABSENT
// (spec's 2026-07-14 amendment: `kind` is populated as `headless`/
// `interactive` whenever a SessionStart line was captured, and reads
// ABSENT only as the drift fallback for a session with none). It must
// never print as a blank column or a guessed value.

import type { IngestReport } from "../ingest/index.js";
import type { WorktreeGap } from "../worktree-gap.js";
import { ABSENT_MARKER } from "./absent.js";

export type SessionKindOrAbsent = "headless" | "interactive" | null;

export interface SessionLineInput {
  sessionId: string;
  repoRoot: string;
  status: string;
  kind: SessionKindOrAbsent;
  startedAt: string;
  commandCount: number;
  footprintCount: number;
}

// Short id: a prefix of the full session_id, long enough to disambiguate
// in practice without pinning an exact length any consumer depends on.
function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export function renderSessionLine(input: SessionLineInput): string {
  const kindText = input.kind ?? ABSENT_MARKER;
  return [
    shortId(input.sessionId),
    input.repoRoot,
    input.status,
    kindText,
    input.startedAt,
    `cmds:${input.commandCount}`,
    `files:${input.footprintCount}`,
  ].join("  ");
}

// One line per session, unioned across however many repos the caller
// folded in. An explicit empty-state line rather than nothing (spec:
// zero sessions must still exit 0 and say so).
export function renderSessionLines(inputs: SessionLineInput[]): string {
  if (inputs.length === 0) return "no sessions recorded yet.";
  return inputs.map(renderSessionLine).join("\n");
}

// Preserves the ingest slice's contract that a corrupt line is named in
// output by line number (docs/issues/ISS-0007.md "Touching the log
// command") — reformatting is safe, dropping the number is not.
export function renderIngestReport(report: IngestReport, repoRoot: string): string {
  const lines: string[] = [
    `[${repoRoot}] ingested: ${report.eventsInserted} event(s) across ${report.sessionsTouched} session(s)`,
  ];
  if (report.skipped.length > 0) {
    lines.push(`  skipped ${report.skipped.length} corrupt line(s):`);
    for (const skipped of report.skipped) {
      lines.push(`    line ${skipped.lineNo}: ${skipped.reason}`);
    }
  }
  for (const warning of report.warnings) {
    lines.push(`  warning: ${warning}`);
  }
  return lines.join("\n");
}

// Fires only for the gaps it is given — stays silent (returns "") when
// propagation is complete, never printing an always-true warning nobody
// reads.
export function renderWorktreeGapWarnings(gaps: WorktreeGap[]): string {
  return gaps
    .map((gap) => `warning: worktree missing settings file (uncaptured session risk): ${gap.checkoutPath}`)
    .join("\n");
}

export function renderNoRegisteredRepos(): string {
  return 'coreartifact log: no repos registered — run "coreartifact init" in a repo first.';
}
