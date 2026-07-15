// `coreartifact log` — union every registered repo's sessions into one
// flat, honest timeline (docs/issues/ISS-0007.md). This command stays
// thin: for each registered ledger, trigger ingest (the ingest slice's
// mechanism), read back its sessions/events/footprint, and hand
// everything to the renderer (src/render/log.ts) this issue owns. `log`
// never re-derives a fact the ledger already computed.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:sqlite import below is `@ts-ignore`d at
// the import site and re-typed through a local interface.

import { resolveRepoRoot } from "../../install/gitRepo.js";
import { getPaths } from "../../core/paths.js";
import { readRegistry } from "../../core/registry.js";
import { ingest } from "../../ingest/index.js";
import { findWorktreeGaps } from "../../worktree-gap.js";
import {
  renderSessionLines,
  renderIngestReport,
  renderWorktreeGapWarnings,
  renderNoRegisteredRepos,
  type SessionLineInput,
} from "../../render/log.js";

// @ts-ignore -- node:sqlite has no ambient types available in this sandbox
import { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
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
  kind: "headless" | "interactive" | null;
  started_at: string;
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

export async function logCommand(): Promise<number> {
  try {
    resolveRepoRoot(process.cwd());
  } catch {
    process.stderr.write("coreartifact log: not a git repository (or any parent up to the mount point)\n");
    return 1;
  }

  const registry = await readRegistry();
  const registeredRoots = [...registry.keys()];

  if (registeredRoots.length === 0) {
    process.stdout.write(`${renderNoRegisteredRepos()}\n`);
    return 0;
  }

  const sessionLines: SessionLineInput[] = [];
  const reportLines: string[] = [];
  const warningLines: string[] = [];

  for (const repoRoot of registeredRoots) {
    // Step 2 (spec): ingest each registered ledger's spool, then read back
    // its sessions — never skip a repo just because it isn't the one the
    // command was run from (the union across repos this issue adds).
    const report = await ingest(repoRoot);
    reportLines.push(renderIngestReport(report, repoRoot));

    const gaps = findWorktreeGaps(repoRoot);
    if (gaps.length > 0) {
      warningLines.push(renderWorktreeGapWarnings(gaps));
    }

    const paths = getPaths(repoRoot);
    const db = new DatabaseSync(paths.ledger, { readOnly: true });
    try {
      const sessions = db
        .prepare("SELECT session_id, status, kind, started_at FROM sessions ORDER BY started_at")
        .all() as SessionSummaryRow[];

      for (const session of sessions) {
        sessionLines.push({
          sessionId: session.session_id,
          repoRoot,
          status: session.status,
          kind: session.kind,
          startedAt: session.started_at,
          commandCount: countBashCommands(db, session.session_id),
          footprintCount: countFootprint(db, session.session_id),
        });
      }
    } finally {
      db.close();
    }
  }

  const output: string[] = [renderSessionLines(sessionLines), ...reportLines, ...warningLines];
  process.stdout.write(`${output.join("\n")}\n`);
  return 0;
}
