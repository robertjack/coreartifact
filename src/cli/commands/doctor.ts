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
  const worktreeGaps = findWorktreeGaps(repoRoot);

  let absences: AbsenceRow[] = [];
  let sessionVersions: SessionVersionRow[] = [];
  const ledgerExists = existsSync(paths.ledger);
  if (ledgerExists) {
    // readOnly: true — doctor must never write to the ledger, even
    // incidentally (WAL/journal bootstrap), so it opens the same way
    // `show` does rather than reusing openLedger, which creates on demand.
    const db = new DatabaseSync(paths.ledger, { readOnly: true });
    try {
      absences = getAllAbsences(db);
      sessionVersions = db
        .prepare("SELECT session_id, cc_version FROM sessions WHERE cc_version IS NOT NULL")
        .all() as SessionVersionRow[];
    } finally {
      db.close();
    }
  }

  const report = buildDoctorReport({
    runningVersion,
    ledgerExists,
    absences,
    sessionVersions,
    worktreeGaps,
  });

  process.stdout.write(`${report.lines.join("\n")}\n`);
  return report.exitCode;
}
