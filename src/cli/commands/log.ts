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

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { existsSync as existsSyncFn } from "node:fs";
import { getPaths } from "../../core/paths.js";
import { readRegistry } from "../../core/registry.js";
import { ingest } from "../../ingest/index.js";
import { findWorktreeGaps } from "../../worktree-gap.js";
import {
  renderSessionLines,
  renderIngestReport,
  renderWorktreeGapWarnings,
  renderNoRegisteredRepos,
  renderRepoUnavailable,
  type SessionLineInput,
} from "../../render/log.js";

// @ts-ignore -- node:sqlite has no ambient types available in this sandbox
import { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";

const existsSync = existsSyncFn as (path: string) => boolean;

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

// Hand-rolled join: same rationale as src/core/paths.ts and
// src/worktree-gap.ts — this file owns no shared path-join module.
function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

// Reachability MUST be checked before ever calling ingest() (S3 fix,
// 2026-07-14 review finding): ingest -> openLedger does `mkdirSync(dataDir,
// { recursive: true })` before it ever touches the spool, so naively
// ingesting a registered-but-deleted repo brings `<repoRoot>/.coreartifact/`
// (and even `repoRoot` itself, since mkdirSync recursive creates every
// missing parent) back from the dead — then the report contradicts itself
// ("ingested 0" alongside "unreachable"). A repo that was genuinely
// `init`-ed always has `.coreartifact/` on disk (init creates it
// synchronously, before any session ever runs) — so its absence, or the
// repo root's own absence, is conclusive: skip and warn, never ingest.
function isRepoReachable(repoRoot: string): boolean {
  return existsSync(repoRoot) && existsSync(joinPath(repoRoot, ".coreartifact"));
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
  const warningLines: string[] = [];

  for (const repoRoot of registeredRoots) {
    // Step 2 (spec): ingest each registered ledger's spool, then read back
    // its sessions — never skip a repo just because it isn't the one the
    // command was run from (the union across repos this issue adds).
    //
    // The registry is append-only with no unregister in v1 (PRD-0002), so a
    // registered root the user later moves or deletes is a normal, reachable
    // state — degradation law applied to the loop itself: one unreachable
    // repo must fold to a named skip, never abort the union before the
    // reachable repos' sessions print (2026-07-14 review finding S1).
    if (!isRepoReachable(repoRoot)) {
      warningLines.push(renderRepoUnavailable(repoRoot, "repo root or .coreartifact/ not found on disk"));
      continue;
    }

    try {
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
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warningLines.push(renderRepoUnavailable(repoRoot, reason));
    }
  }

  const output: string[] = [renderSessionLines(sessionLines), ...reportLines, ...warningLines];
  process.stdout.write(`${output.join("\n")}\n`);
  return 0;
}
