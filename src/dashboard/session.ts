// GET /api/session/<id> — the session view (api.md Surface D): the same
// evidence `show` derives (src/cli/commands/show.ts, src/facets/outcome.ts),
// structured as JSON. Resolution reuses the shared union walk
// (`walkRegisteredRepos`/`classifySessionMatch`, src/resolve-session.ts) —
// never a second ingest implementation, never a private resolution copy.
// The response never carries raw event payloads: the derived facets and the
// four nesting keys (prompt_id/agent_id/agent_type/tool_use_id) are the
// wire interface (api.md "the dashboard is a viewer, not a spool browser").
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:sqlite import below is `@ts-ignore`d at
// the import site and re-typed through a local interface, same pattern as
// src/cli/commands/show.ts.

import { getPaths } from "../core/paths.js";
import { readRegistry } from "../core/registry.js";
import {
  walkRegisteredRepos,
  classifySessionMatch,
  type SessionCandidate,
  type SessionMatchResult,
} from "../resolve-session.js";
import {
  deriveCommandFacet,
  deriveInFlightCommandFacet,
  deriveBackgroundedOutcome,
  isBashToolPayload,
  type BackgroundJoinCandidate,
  type Outcome,
} from "../facets/outcome.js";
import { READ_BUSY_TIMEOUT_MS } from "./constants.js";
import type { ApiHandler, ApiResult } from "./routes.js";

// @ts-ignore -- node:sqlite has no ambient types available in this sandbox
import { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";

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

interface SessionRow {
  session_id: string;
  repo_root: string;
  worktree_path: string | null;
  kind: "headless" | "interactive" | null;
  status: string;
  sha_before: string | null;
  sha_after: string | null;
  started_at: string;
  last_event_at: string;
  ended_at: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
  cost_usd: number | null;
  model: string | null;
  cc_version: string | null;
}

interface FootprintRow {
  path: string;
}

interface CheckRow {
  name: string;
  exit_code: number;
  truncated: number;
  bound_by: string | null;
}

interface TestResultRow {
  line_no: number;
  parser: string;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number | null;
  failed_names: string;
}

interface EventRow {
  line_no: number;
  seq: number;
  ts: string;
  hook_event_name: string;
  prompt_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  tool_use_id: string | null;
  background_task_id: string | null;
  payload: string;
}

interface TestResultsBadge {
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number | null;
  failed_names: string[];
}

function parseFailedNames(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    // Malformed JSON degrades to an empty list rather than throwing —
    // same degradation stance as show.ts's own toTestResultsBadge.
    return [];
  }
}

function toBadge(row: TestResultRow): TestResultsBadge {
  return {
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
    duration_ms: row.duration_ms,
    failed_names: parseFailedNames(row.failed_names),
  };
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A malformed payload degrades to an empty object rather than
    // aborting the whole timeline (degradation law).
    return {};
  }
}

// Mirrors show.ts's isFoldedBashPreToolUse: a PAIRED Bash PreToolUse folds
// away (its Post renders the command's one line); an UNPAIRED Pre is the
// in-flight command of a session that died mid-command and must stay
// visible with outcome ABSENT.
function isFoldedBashPreToolUse(
  hookEventName: string,
  payload: Record<string, unknown>,
  toolUseId: string | null,
  pairedPostToolUseIds: Set<string>,
): boolean {
  if (hookEventName !== "PreToolUse" || !isBashToolPayload(payload)) return false;
  return toolUseId !== null && pairedPostToolUseIds.has(toolUseId);
}

interface TimelineEntryBase {
  seq: number;
  ts: string;
  kind: "lifecycle" | "prompt" | "command" | "subagent";
  prompt_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  tool_use_id: string | null;
}

type TimelineEntry = TimelineEntryBase & Record<string, unknown>;

function buildTimelineEntry(
  row: EventRow,
  pairedPostToolUseIds: Set<string>,
  testResultsByLineNo: Map<number, TestResultsBadge>,
  backgroundJoinCandidates: BackgroundJoinCandidate[],
): TimelineEntry | null {
  const payload = parsePayload(row.payload);
  const base = {
    seq: row.seq,
    ts: row.ts,
    prompt_id: row.prompt_id,
    agent_id: row.agent_id,
    agent_type: row.agent_type,
    tool_use_id: row.tool_use_id,
  };

  if (row.hook_event_name === "UserPromptSubmit") {
    const prompt = payload.prompt;
    return { ...base, kind: "prompt", prompt: typeof prompt === "string" ? prompt : "" };
  }

  if (row.hook_event_name === "SubagentStart" || row.hook_event_name === "SubagentStop") {
    return { ...base, kind: "subagent", hook_event_name: row.hook_event_name };
  }

  if (
    (row.hook_event_name === "PostToolUse" || row.hook_event_name === "PostToolUseFailure") &&
    isBashToolPayload(payload)
  ) {
    const facet = deriveCommandFacet({ hookEventName: row.hook_event_name, payload });
    const outcome: Outcome =
      facet.outcome.state === "absent" && row.background_task_id !== null
        ? deriveBackgroundedOutcome(row.background_task_id, backgroundJoinCandidates)
        : facet.outcome;
    return {
      ...base,
      kind: "command",
      command: facet.command,
      duration_ms: facet.durationMs,
      outcome,
      test_results: testResultsByLineNo.get(row.line_no) ?? null,
    };
  }

  if (row.hook_event_name === "PreToolUse" && isBashToolPayload(payload)) {
    if (isFoldedBashPreToolUse(row.hook_event_name, payload, row.tool_use_id, pairedPostToolUseIds)) {
      return null;
    }
    const facet = deriveInFlightCommandFacet(payload);
    return {
      ...base,
      kind: "command",
      command: facet.command,
      duration_ms: facet.durationMs,
      outcome: facet.outcome,
      test_results: null,
    };
  }

  return { ...base, kind: "lifecycle", hook_event_name: row.hook_event_name };
}

// Resolution scoped to at most one registered root (api.md `?repo=`
// scoping, Surface D) — the same shared walk `resolveSession` uses,
// generalized here so the endpoint can honor `onlyRoot` (resolveSession
// itself always walks the full union).
async function resolveScoped(
  sessionArg: string,
  onlyRoot: string | undefined,
): Promise<SessionMatchResult> {
  const candidates: SessionCandidate[] = [];
  await walkRegisteredRepos(
    ({ repoRoot, db }) => {
      const rows = db.prepare("SELECT session_id FROM sessions").all() as { session_id: string }[];
      for (const row of rows) candidates.push({ sessionId: row.session_id, repoRoot });
    },
    { onlyRoot },
  );
  return classifySessionMatch(sessionArg, candidates);
}

export const sessionHandler: ApiHandler = async (req, params) => {
  const url = new URL(req.url ?? `/api/session/${params.id}`, "http://coreartifact.internal");
  const repoParam = url.searchParams.get("repo");
  const sessionArg = params.id ?? "";

  const registry = await readRegistry();
  if (repoParam !== null && !registry.has(repoParam)) {
    return {
      status: 404,
      body: { error: { code: "repo_not_registered", message: `repo not registered: ${repoParam}` } },
    };
  }

  const resolved = await resolveScoped(sessionArg, repoParam ?? undefined);

  if (resolved.kind === "not-found" || resolved.kind === "usage-error") {
    return {
      status: 404,
      body: {
        error: {
          code: "unknown_session",
          message: `no session found for id: ${sessionArg}`,
        },
      },
    };
  }

  if (resolved.kind === "ambiguous") {
    const roots = resolved.candidates.map((c) => c.repoRoot);
    return {
      status: 404,
      body: {
        error: {
          code: "unknown_session",
          message:
            `session ${sessionArg} does not uniquely resolve: candidate roots are ${roots.join(", ")}`,
        },
      },
    };
  }

  const { repoRoot, sessionId } = resolved;
  const paths = getPaths(repoRoot);
  const db = new DatabaseSync(paths.ledger, { readOnly: true });
  // api.md Flag 1 / R5: every read connection the API opens sets
  // busy_timeout so a concurrent writer never surfaces "database is
  // locked" — walkRegisteredRepos's own db is already closed by the time
  // resolution finishes, so this second connection sets the pragma again.
  db.exec(`PRAGMA busy_timeout = ${READ_BUSY_TIMEOUT_MS}`);
  try {
    const sessionRow = db
      .prepare(
        "SELECT session_id, repo_root, worktree_path, kind, status, sha_before, sha_after, started_at, last_event_at, ended_at, tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, cost_usd, model, cc_version FROM sessions WHERE session_id = ?",
      )
      .get(sessionId) as SessionRow | undefined;

    if (!sessionRow) {
      // Cannot happen on the path resolveScoped's "found" result takes
      // (the row it just read session_id off of), but the degradation law
      // still applies rather than assuming: never crash on a row that
      // vanished between resolution and this read (same stance as
      // show.ts).
      return {
        status: 404,
        body: { error: { code: "unknown_session", message: `no session found for id: ${sessionId}` } },
      };
    }

    const footprintRows = db.prepare("SELECT path FROM footprint WHERE session_id = ?").all(sessionId) as FootprintRow[];

    const checkRows = db
      .prepare("SELECT name, exit_code, truncated, bound_by FROM checks WHERE session_id = ?")
      .all(sessionId) as CheckRow[];

    const testResultRows = db
      .prepare(
        "SELECT line_no, parser, passed, failed, skipped, duration_ms, failed_names FROM test_results WHERE session_id = ?",
      )
      .all(sessionId) as TestResultRow[];
    const testResultsByLineNo = new Map<number, TestResultsBadge>(
      testResultRows.map((row) => [row.line_no, toBadge(row)]),
    );

    // absences: read directly rather than through core/absence.ts's own
    // getSessionAbsences to avoid a structural type mismatch (that module's
    // SqliteStatement additionally requires a `run` method this read-only
    // connection's minimal interface doesn't declare) — same shape, same
    // table (session_id, facet, reason), copied verbatim.
    const absenceRows = db
      .prepare("SELECT facet, reason FROM absences WHERE session_id = ?")
      .all(sessionId) as { facet: string; reason: string }[];

    const eventRows = db
      .prepare(
        "SELECT line_no, seq, ts, hook_event_name, prompt_id, agent_id, agent_type, tool_use_id, background_task_id, payload FROM events WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as EventRow[];

    const pairedPostToolUseIds = new Set<string>();
    for (const row of eventRows) {
      if (
        (row.hook_event_name === "PostToolUse" || row.hook_event_name === "PostToolUseFailure") &&
        row.tool_use_id !== null
      ) {
        pairedPostToolUseIds.add(row.tool_use_id);
      }
    }

    const backgroundJoinCandidates: BackgroundJoinCandidate[] = eventRows
      .filter((row) => row.background_task_id !== null)
      .map((row) => ({ backgroundTaskId: row.background_task_id, payload: parsePayload(row.payload) }));

    const timeline: TimelineEntry[] = [];
    for (const row of eventRows) {
      const entry = buildTimelineEntry(row, pairedPostToolUseIds, testResultsByLineNo, backgroundJoinCandidates);
      if (entry !== null) timeline.push(entry);
    }

    const tokensAllPresent =
      sessionRow.tokens_input !== null &&
      sessionRow.tokens_output !== null &&
      sessionRow.tokens_cache_read !== null &&
      sessionRow.tokens_cache_creation !== null;

    const result: ApiResult = {
      status: 200,
      body: {
        facets: {
          session_id: sessionRow.session_id,
          repo_root: sessionRow.repo_root,
          worktree_path: sessionRow.worktree_path,
          status: sessionRow.status,
          kind: sessionRow.kind,
          sha_before: sessionRow.sha_before,
          sha_after: sessionRow.sha_after,
          model: sessionRow.model,
          cc_version: sessionRow.cc_version,
          cost: { value: sessionRow.cost_usd, derived: true },
          tokens: {
            derived: true,
            input: tokensAllPresent ? sessionRow.tokens_input : null,
            output: tokensAllPresent ? sessionRow.tokens_output : null,
            cache_read: tokensAllPresent ? sessionRow.tokens_cache_read : null,
            cache_creation: tokensAllPresent ? sessionRow.tokens_cache_creation : null,
          },
          started_at: sessionRow.started_at,
          last_event_at: sessionRow.last_event_at,
          ended_at: sessionRow.ended_at,
        },
        checks: checkRows.map((row) => ({
          name: row.name,
          exit_code: row.exit_code,
          passed: row.exit_code === 0,
          truncated: row.truncated === 1,
          bound_by: row.bound_by,
        })),
        test_results: testResultRows.map((row) => ({
          line_no: row.line_no,
          parser: row.parser,
          passed: row.passed,
          failed: row.failed,
          skipped: row.skipped,
          duration_ms: row.duration_ms,
          failed_names: parseFailedNames(row.failed_names),
        })),
        footprint: footprintRows.map((row) => row.path),
        absences: absenceRows,
        timeline,
      },
    };
    return result;
  } finally {
    db.close();
  }
};
