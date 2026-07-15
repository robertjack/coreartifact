// `coreartifact show <session>` — the flat timeline, and the three-state
// outcome (docs/issues/ISS-0008.md). Like `log`, ingest is lazy and runs at
// read time here too (src/ingest/index.ts: "triggered by `log` (and later
// `show`)") — `show` never requires a separate `log` invocation first, it
// just happens that the acceptance tests exercise it that way.
//
// ISS-0012: `show` is now GLOBAL and prefix-tolerant, symmetrical with
// `log` — the argument is resolved across every registered repo's ledger
// (src/resolve-session.ts), not just cwd's, and matches an exact full
// session id OR a unique prefix (the short id `log` prints). This fixes the
// cross-slice mismatch the 2026-07-15 integration review found: `log` is
// global/short-id, `show` was cwd-only/full-uuid-only, so the
// log -> copy id -> show handoff never worked.
//
// This command stays thin: resolve the session via the shared module, read
// the resolved repo's ledger rows, derive the per-event facets this issue
// owns (src/facets/outcome.ts), and hand everything to the renderer
// (src/render/show.ts) that owns formatting. `show` never re-derives a fact
// the ledger or ingest already computed, and it never writes anything —
// reading the ledger the ingest module maintains is its only side effect.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:sqlite import below is `@ts-ignore`d at
// the import site and re-typed through a local interface, same as
// src/cli/commands/log.ts.

import { getPaths } from "../../core/paths.js";
import { resolveSession } from "../../resolve-session.js";
import { deriveCommandFacet, deriveInFlightCommandFacet, isBashToolPayload } from "../../facets/outcome.js";
import { renderShow, renderUnknownSession, renderAmbiguousMatch, type TimelineEntry } from "../../render/show.js";

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

interface SessionRow {
  session_id: string;
  sha_before: string | null;
  sha_after: string | null;
}

interface FootprintRow {
  path: string;
}

interface EventRow {
  seq: number;
  ts: string;
  hook_event_name: string;
  agent_id: string | null;
  agent_type: string | null;
  tool_use_id: string | null;
  payload: string;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A malformed payload degrades to an empty object rather than
    // aborting the whole timeline (degradation law: one bad row is never
    // allowed to hide the rest of the evidence).
    return {};
  }
}

// PreToolUse on a Bash command carries the command string but no
// outcome/duration of its own. When its PAIRED PostToolUse/PostToolUseFailure
// exists (matched by tool_use_id), the Post renders the command's one
// timeline line and the Pre folds away — rendering both would show every
// command twice. But an UNPAIRED Pre is the in-flight command of a session
// that died mid-command (SIGKILL: the stream just stops) — the very case
// PreToolUse is subscribed for — and MUST stay visible with outcome ABSENT.
// Folding it unconditionally made the dying command vanish and put show's
// timeline in disagreement with log's command count (integration-review S2,
// 2026-07-15: log counts distinct Bash tool_use_ids across ALL events).
function isFoldedBashPreToolUse(
  hookEventName: string,
  payload: Record<string, unknown>,
  toolUseId: string | null,
  pairedPostToolUseIds: Set<string>,
): boolean {
  if (hookEventName !== "PreToolUse" || !isBashToolPayload(payload)) return false;
  return toolUseId !== null && pairedPostToolUseIds.has(toolUseId);
}

function buildTimelineEntry(row: EventRow, pairedPostToolUseIds: Set<string>): TimelineEntry | null {
  const payload = parsePayload(row.payload);

  if (row.hook_event_name === "UserPromptSubmit") {
    const prompt = payload.prompt;
    return {
      kind: "prompt",
      seq: row.seq,
      ts: row.ts,
      text: typeof prompt === "string" ? prompt : "",
    };
  }

  if (row.hook_event_name === "SubagentStart" || row.hook_event_name === "SubagentStop") {
    return {
      kind: "subagent",
      seq: row.seq,
      ts: row.ts,
      hookEventName: row.hook_event_name,
      agentId: row.agent_id,
      agentType: row.agent_type,
    };
  }

  if (
    (row.hook_event_name === "PostToolUse" || row.hook_event_name === "PostToolUseFailure") &&
    isBashToolPayload(payload)
  ) {
    const facet = deriveCommandFacet({ hookEventName: row.hook_event_name, payload });
    return {
      kind: "command",
      seq: row.seq,
      ts: row.ts,
      command: facet.command,
      outcome: facet.outcome,
      durationMs: facet.durationMs,
    };
  }

  if (row.hook_event_name === "PreToolUse" && isBashToolPayload(payload)) {
    if (isFoldedBashPreToolUse(row.hook_event_name, payload, row.tool_use_id, pairedPostToolUseIds)) {
      return null;
    }
    // Unpaired: the in-flight command of a session that died mid-command.
    const facet = deriveInFlightCommandFacet(payload);
    return {
      kind: "command",
      seq: row.seq,
      ts: row.ts,
      command: facet.command,
      outcome: facet.outcome,
      durationMs: facet.durationMs,
    };
  }

  return { kind: "lifecycle", seq: row.seq, ts: row.ts, hookEventName: row.hook_event_name };
}

export async function showCommand(args: string[]): Promise<number> {
  // Resolution walks the FULL registry union (like `log`), lazily ingesting
  // each reachable repo along the way — this is the seam the 2026-07-15
  // integration review found missing: show has no cwd/repo-root requirement
  // of its own any more.
  const sessionArg = args[0] ?? "";
  const resolved = await resolveSession(sessionArg);

  // Registry-walk warnings (unreachable/corrupt repos) are rendered
  // regardless of outcome — the same degradation contract `log` has, never
  // swallowed just because resolution itself succeeded.
  for (const warning of resolved.warnings) {
    process.stderr.write(`${warning}\n`);
  }

  if (resolved.kind === "usage-error") {
    process.stderr.write(`${resolved.message}\n`);
    return 1;
  }
  if (resolved.kind === "not-found") {
    process.stderr.write(`${renderUnknownSession(resolved.sessionArg)}\n`);
    return 1;
  }
  if (resolved.kind === "ambiguous") {
    process.stderr.write(`${renderAmbiguousMatch(resolved.sessionArg, resolved.candidates)}\n`);
    return 1;
  }

  const { repoRoot, sessionId } = resolved;
  const paths = getPaths(repoRoot);

  const db = new DatabaseSync(paths.ledger, { readOnly: true });
  try {
    const sessionRow = db
      .prepare("SELECT session_id, sha_before, sha_after FROM sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;

    if (!sessionRow) {
      // Cannot happen on the path resolveSession's "found" result takes
      // (the row it just read session_id off of), but the degradation law
      // still applies rather than assuming: never crash on a row that
      // vanished between resolution and this read.
      process.stderr.write(`${renderUnknownSession(sessionId)}\n`);
      return 1;
    }

    const footprintRows = db
      .prepare("SELECT path FROM footprint WHERE session_id = ?")
      .all(sessionId) as FootprintRow[];

    const eventRows = db
      .prepare(
        "SELECT seq, ts, hook_event_name, agent_id, agent_type, tool_use_id, payload FROM events WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as EventRow[];

    // A Bash Pre folds only when its paired Post exists in this session;
    // an unpaired Pre is the in-flight command and renders with outcome
    // ABSENT (see isFoldedBashPreToolUse).
    const pairedPostToolUseIds = new Set<string>();
    for (const row of eventRows) {
      if (
        (row.hook_event_name === "PostToolUse" || row.hook_event_name === "PostToolUseFailure") &&
        row.tool_use_id !== null
      ) {
        pairedPostToolUseIds.add(row.tool_use_id);
      }
    }

    const entries: TimelineEntry[] = [];
    for (const row of eventRows) {
      const entry = buildTimelineEntry(row, pairedPostToolUseIds);
      if (entry !== null) entries.push(entry);
    }

    const output = renderShow(
      {
        sessionId: sessionRow.session_id,
        shaBefore: sessionRow.sha_before,
        shaAfter: sessionRow.sha_after,
        footprint: footprintRows.map((row) => row.path),
      },
      entries,
    );
    process.stdout.write(`${output}\n`);
    return 0;
  } finally {
    db.close();
  }
}
