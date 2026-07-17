// Session resolution — the shared seam `log` and `show` both lean on
// (ISS-0012, fixing the 2026-07-15 integration review's cross-slice
// mismatch: `log` is global/short-id, `show` was cwd-only/full-uuid-only).
// `show <session>` now resolves its argument across the SAME registry union
// `log` already walks, with the SAME per-repo isolation (unreachable/corrupt
// repos warn-and-skip, never sink the lookup) — factored here so neither
// command grows a private copy of the walk.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:fs/node:sqlite imports below are
// `@ts-ignore`d at the import site and re-typed through a local interface,
// same pattern as src/cli/commands/log.ts.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { existsSync as existsSyncFn } from "node:fs";
import { getPaths } from "./core/paths.js";
import { readRegistry } from "./core/registry.js";
import { ingest, type IngestReport } from "./ingest/index.js";
import { renderRepoUnavailable } from "./render/log.js";

// @ts-ignore -- node:sqlite has no ambient types available in this sandbox
import { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";

const existsSync = existsSyncFn as (path: string) => boolean;

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const DatabaseSync = DatabaseSyncCtor as unknown as new (
  path: string,
  options?: { readOnly?: boolean },
) => SqliteDatabase;

// api.md Flag 1 / R5: every read connection the API opens must set
// busy_timeout so a concurrent writer never surfaces "database is locked" —
// reused from src/core/ledger.ts's own BUSY_TIMEOUT_MS value (5000), not
// re-declared as a separate number that could drift from it.
export const READ_BUSY_TIMEOUT_MS = 5000;

// Hand-rolled join: same rationale as src/core/paths.ts and
// src/cli/commands/log.ts — this file owns no shared path-join module.
function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

// Same reachability check log.ts uses (S3 fix, 2026-07-14 review finding):
// a registered-but-deleted repo must never be ingested, which would recreate
// its .coreartifact/ (and even repoRoot itself) from the dead via ingest's
// mkdirSync(recursive: true).
export function isRepoReachable(repoRoot: string): boolean {
  return existsSync(repoRoot) && existsSync(joinPath(repoRoot, ".coreartifact"));
}

export interface RepoVisit {
  repoRoot: string;
  db: SqliteDatabase;
  report: IngestReport;
}

// One entry per registered root actually walked — the structured
// counterpart to `warnings` (a human-readable string), added for the
// overview endpoint's `repos` field (api.md Surface C), which needs the
// root + status + reason as data, not a rendered sentence to re-parse.
export interface RepoStatus {
  root: string;
  status: "ok" | "unreadable";
  reason?: string;
}

export interface RegisteredRepoWalk {
  registeredRoots: string[];
  warnings: string[];
  repoStatuses: RepoStatus[];
}

export interface WalkRegisteredReposOptions {
  // Scopes the walk to exactly this one registered root (api.md `?repo=`
  // scoping, Surface C/D) — the caller is responsible for having already
  // confirmed the root is registered (a 404 `repo_not_registered` decision
  // lives at the HTTP layer, not here).
  onlyRoot?: string;
}

// Walks every registered repo: reachability check, lazy ingest (per repo,
// exactly as `log` does), opens its ledger read-only and hands it to
// `onRepo`. An unreachable or errored repo folds to a named warning and is
// skipped — never sinks the walk for the reachable repos (degradation law
// applied to the loop itself, same as log.ts's own contract).
export async function walkRegisteredRepos(
  onRepo: (visit: RepoVisit) => void | Promise<void>,
  options: WalkRegisteredReposOptions = {},
): Promise<RegisteredRepoWalk> {
  const registry = await readRegistry();
  const allRoots = [...registry.keys()];
  const registeredRoots =
    options.onlyRoot !== undefined ? allRoots.filter((root) => root === options.onlyRoot) : allRoots;
  const warnings: string[] = [];
  const repoStatuses: RepoStatus[] = [];

  for (const repoRoot of registeredRoots) {
    if (!isRepoReachable(repoRoot)) {
      const reason = "repo root or .coreartifact/ not found on disk";
      warnings.push(renderRepoUnavailable(repoRoot, reason));
      repoStatuses.push({ root: repoRoot, status: "unreadable", reason });
      continue;
    }

    try {
      const report = await ingest(repoRoot);
      const paths = getPaths(repoRoot);
      const db = new DatabaseSync(paths.ledger, { readOnly: true });
      // R5 (api.md Flag 1): every read connection the API opens sets
      // busy_timeout so a concurrent writer never surfaces "database is
      // locked" — this is the one shared place that amendment lands.
      db.exec(`PRAGMA busy_timeout = ${READ_BUSY_TIMEOUT_MS}`);
      try {
        repoStatuses.push({ root: repoRoot, status: "ok" });
        await onRepo({ repoRoot, db, report });
      } finally {
        db.close();
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(renderRepoUnavailable(repoRoot, reason));
      repoStatuses.push({ root: repoRoot, status: "unreadable", reason });
    }
  }

  return { registeredRoots, warnings, repoStatuses };
}

// The short id `log` prints (src/render/log.ts's own `shortId`, an 8-char
// prefix) is the floor: a prefix shorter than what a user could actually
// copy off log's stdout is a usage error, never a match-everything
// wildcard (the phantom-match bug class — an empty prefix matching every
// session).
export const MIN_SESSION_PREFIX_LENGTH = 8;

export interface SessionCandidate {
  sessionId: string;
  repoRoot: string;
}

export type SessionMatchResult =
  | { kind: "usage-error"; message: string }
  | { kind: "not-found"; sessionArg: string }
  | { kind: "ambiguous"; sessionArg: string; candidates: SessionCandidate[] }
  | { kind: "found"; sessionId: string; repoRoot: string };

// Pure classification over an already-collected candidate list — no I/O, so
// this is the seam tests/unit/resolve-session.test.ts exercises directly
// (exact match, unique prefix, ambiguous, too-short, unknown).
export function classifySessionMatch(sessionArg: string, candidates: SessionCandidate[]): SessionMatchResult {
  if (sessionArg.length < MIN_SESSION_PREFIX_LENGTH) {
    return {
      kind: "usage-error",
      message:
        `coreartifact show: usage: coreartifact show <session> ` +
        `(must be a full session id or a prefix of at least ${MIN_SESSION_PREFIX_LENGTH} characters)`,
    };
  }

  const matches = candidates.filter(
    (c) => c.sessionId === sessionArg || c.sessionId.startsWith(sessionArg),
  );

  if (matches.length === 0) {
    return { kind: "not-found", sessionArg };
  }

  // An exact full-id match that is present in more than one repo's ledger is
  // STILL ambiguous (spec: "For a full-id match in multiple repos, the same
  // rule applies") — replaying the same fixture stream into two repos yields
  // the same session_id in both, and picking one silently would be a
  // fabricated receipt.
  if (matches.length > 1) {
    return { kind: "ambiguous", sessionArg, candidates: matches };
  }

  const only = matches[0]!;
  return { kind: "found", sessionId: only.sessionId, repoRoot: only.repoRoot };
}

interface SessionIdRow {
  session_id: string;
}

// The I/O wrapper: collects every session_id across the registry union
// (ingesting each reachable repo lazily, same as `log`), then classifies.
// Warnings from the walk (unreachable/corrupt repos) are surfaced alongside
// the result rather than swallowed, so `show` can render them regardless of
// whether resolution itself succeeded.
export async function resolveSession(
  sessionArg: string,
): Promise<SessionMatchResult & { warnings: string[] }> {
  const candidates: SessionCandidate[] = [];

  const { warnings } = await walkRegisteredRepos(({ repoRoot, db }) => {
    const rows = db.prepare("SELECT session_id FROM sessions").all() as SessionIdRow[];
    for (const row of rows) {
      candidates.push({ sessionId: row.session_id, repoRoot });
    }
  });

  const result = classifySessionMatch(sessionArg, candidates);
  return { ...result, warnings };
}
