// `coreartifact doctor` — the drift reporter (docs/issues/ISS-0021.md).
// Read-only is a law here: doctor never triggers ledger creation, never
// ingests, never writes anywhere. It reads what already exists — the
// running Claude Code version (executed fresh, never cached), the tested
// range constant, the ledger's absences table (only if the ledger already
// exists), and the worktree-gap module (reused verbatim, never
// re-derived). Exit 0 when nothing degrades; nonzero, naming each
// finding, when anything does.
//
// @types/node is unreachable in this sandbox (no network, nothing cached
// — see src/core/paths.ts) — the node:fs and node:sqlite imports below are
// `@ts-ignore`d at the import site and re-typed through local interfaces,
// same pattern as src/cli/commands/show.ts.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { existsSync as existsSyncFn } from "node:fs";
// @ts-ignore -- node:sqlite has no ambient types available in this sandbox
import { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";

import { getPaths } from "../../core/paths.js";
import { resolveAttribution } from "../../core/attribution.js";
import { findWorktreeGaps } from "../../worktree-gap.js";
import { getAllAbsences, type AbsenceRow } from "../../core/absence.js";
import { getRunningClaudeVersion } from "../../doctor/version.js";
import { buildDoctorReport } from "../../doctor/report.js";

const existsSync = existsSyncFn as (path: string) => boolean;

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const DatabaseSync = DatabaseSyncCtor as unknown as new (
  path: string,
  options?: { readOnly?: boolean },
) => SqliteDatabase;

declare const process: {
  cwd(): string;
  stdout: { write(chunk: string): boolean };
};

interface SessionVersionRow {
  session_id: string;
  cc_version: string;
}

export async function doctorCommand(): Promise<number> {
  const cwd = process.cwd();
  const { repoRoot } = await resolveAttribution(cwd, cwd);
  const paths = getPaths(repoRoot);

  const runningVersion = await getRunningClaudeVersion();

  let worktreeGaps: { checkoutPath: string }[] = [];
  let worktreeScanError: string | null = null;
  try {
    worktreeGaps = findWorktreeGaps(repoRoot);
  } catch (err) {
    // Out-of-spec input (doctor is repo-scoped): a non-git cwd or any other
    // shell-out failure degrades to a named finding rather than a raw
    // stack trace (F134/F136, degradation law).
    worktreeScanError = err instanceof Error ? err.message : String(err);
  }

  let absences: AbsenceRow[] = [];
  let sessionVersions: SessionVersionRow[] = [];
  let ledgerReadError: string | null = null;
  const ledgerExists = existsSync(paths.ledger);
  if (ledgerExists) {
    // readOnly: true — doctor must never write to the ledger, even
    // incidentally (WAL/journal bootstrap), so it opens the same way
    // `show` does rather than reusing openLedger, which creates on demand.
    try {
      const db = new DatabaseSync(paths.ledger, { readOnly: true });
      try {
        // busy_timeout defaults to 0 on a fresh node:sqlite connection —
        // without it, a concurrent writer's lock crashes doctor instead of
        // making it wait (F135; mirrors openLedger in core/ledger.ts).
        db.exec("PRAGMA busy_timeout = 5000");
        absences = getAllAbsences(db);
        sessionVersions = db
          .prepare("SELECT session_id, cc_version FROM sessions WHERE cc_version IS NOT NULL")
          .all() as SessionVersionRow[];
      } finally {
        db.close();
      }
    } catch (err) {
      // A 0-byte file mid-creation, a truncated/corrupt ledger, a pre-v2
      // ledger, or a lock held past the timeout — never a crash, always a
      // named "we don't know" (F132, degradation law).
      ledgerReadError = err instanceof Error ? err.message : String(err);
    }
  }

  const report = buildDoctorReport({
    runningVersion,
    ledgerExists,
    absences,
    sessionVersions,
    worktreeGaps,
    ledgerReadError,
    worktreeScanError,
  });

  process.stdout.write(`${report.lines.join("\n")}\n`);
  return report.exitCode;
}
