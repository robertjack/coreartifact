// `coreartifact show <session>` — the flat timeline, and the three-state
// outcome (docs/issues/ISS-0008.md). Like `log`, ingest is lazy and runs at
// read time here too (src/ingest/index.ts: "triggered by `log` (and later
// `show`)") — `show` never requires a separate `log` invocation first, it
// just happens that the acceptance tests exercise it that way.
//
// This command stays thin: read the ledger's rows, derive the per-event
// facets this issue owns (src/facets/outcome.ts), and hand everything to the
// renderer (src/render/show.ts) that owns formatting. `show` never
// re-derives a fact the ledger or ingest already computed, and it never
// writes anything — reading the ledger the ingest module maintains is its
// only side effect.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:sqlite import below is `@ts-ignore`d at
// the import site and re-typed through a local interface, same as
// src/cli/commands/log.ts.

import { getPaths } from "../../core/paths.js";
import { ingest } from "../../ingest/index.js";
import { deriveCommandFacet, isBashToolPayload } from "../../facets/outcome.js";
import { renderShow, renderUnknownSession, type TimelineEntry } from "../../render/show.js";

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
// outcome/duration of its own — the paired PostToolUse/PostToolUseFailure
// event renders that command's one timeline line. Rendering PreToolUse too
// would show every command twice.
function isFoldedBashPreToolUse(hookEventName: string, payload: Record<string, unknown>): boolean {
  return hookEventName === "PreToolUse" && isBashToolPayload(payload);
}

function buildTimelineEntry(row: EventRow): TimelineEntry | null {
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

  if (isFoldedBashPreToolUse(row.hook_event_name, payload)) {
    return null;
  }

  return { kind: "lifecycle", seq: row.seq, ts: row.ts, hookEventName: row.hook_event_name };
}

export async function showCommand(args: string[]): Promise<number> {
  const sessionId = args[0];
  if (!sessionId) {
    process.stderr.write("coreartifact show: usage: coreartifact show <session>\n");
    return 1;
  }

  const repoRoot = process.cwd();
  const paths = getPaths(repoRoot);

  // Lazy ingest, same contract as `log` (spec: "show writes nothing but the
  // ledger the ingest module maintains" — triggering ingest is reading the
  // spool forward, not a write of show's own).
  await ingest(repoRoot);

  const db = new DatabaseSync(paths.ledger, { readOnly: true });
  try {
    const sessionRow = db
      .prepare("SELECT session_id, sha_before, sha_after FROM sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;

    if (!sessionRow) {
      process.stderr.write(`${renderUnknownSession(sessionId)}\n`);
      return 1;
    }

    const footprintRows = db
      .prepare("SELECT path FROM footprint WHERE session_id = ?")
      .all(sessionId) as FootprintRow[];

    const eventRows = db
      .prepare(
        "SELECT seq, ts, hook_event_name, agent_id, agent_type, payload FROM events WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as EventRow[];

    const entries: TimelineEntry[] = [];
    for (const row of eventRows) {
      const entry = buildTimelineEntry(row);
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
