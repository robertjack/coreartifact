// `coreartifact log` — ingest the spool, then print a minimal per-session
// summary (docs/issues/ISS-0006.md). This command stays thin: ingest, then
// hand the result to a renderer seam. The real renderer (formatting,
// absent markers, cross-repo union, the worktree-gap warning) is the log
// slice's (ISS-0007, `src/render/log.ts`) — the rendering below is
// deliberately minimal and expected to be replaced wholesale.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:sqlite import below is `@ts-ignore`d at
// the import site and re-typed through a local interface.

import { resolveRepoRoot } from "../../install/gitRepo.js";
import { getPaths } from "../../core/paths.js";
import { ingest, type IngestReport } from "../../ingest/index.js";

// @ts-ignore -- node:sqlite has no ambient types available in this sandbox
import { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
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
  stderr: { write(chunk: string): boolean };
};

interface SessionSummaryRow {
  session_id: string;
  status: string;
  kind: string | null;
  started_at: string;
}

function renderSessions(rows: SessionSummaryRow[]): string {
  if (rows.length === 0) return "no sessions.";
  return rows
    .map((row) => `${row.session_id}  ${row.status}  ${row.kind ?? "ABSENT"}  ${row.started_at}`)
    .join("\n");
}

function renderReport(report: IngestReport): string {
  const lines: string[] = [
    `ingested: ${report.eventsInserted} event(s) across ${report.sessionsTouched} session(s)`,
  ];
  if (report.skipped.length > 0) {
    lines.push(`skipped ${report.skipped.length} corrupt line(s):`);
    for (const skipped of report.skipped) {
      lines.push(`  line ${skipped.lineNo}: ${skipped.reason}`);
    }
  }
  for (const warning of report.warnings) {
    lines.push(`warning: ${warning}`);
  }
  return lines.join("\n");
}

export async function logCommand(): Promise<number> {
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(process.cwd());
  } catch {
    process.stderr.write("coreartifact log: not a git repository (or any parent up to the mount point)\n");
    return 1;
  }

  const report = await ingest(repoRoot);

  const paths = getPaths(repoRoot);
  const db = new DatabaseSync(paths.ledger, { readOnly: true });
  let rows: SessionSummaryRow[];
  try {
    rows = db
      .prepare("SELECT session_id, status, kind, started_at FROM sessions ORDER BY started_at")
      .all() as SessionSummaryRow[];
  } finally {
    db.close();
  }

  process.stdout.write(`${renderSessions(rows)}\n${renderReport(report)}\n`);
  return 0;
}
