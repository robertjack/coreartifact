// Ingest — the spool becomes the ledger, idempotently and honestly
// (docs/issues/ISS-0006.md). Lazy: runs at read time, triggered by `log`
// (and later `show`), never on a timer or a write path.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts, src/core/ledger.ts) — the node:fs import below is
// `@ts-ignore`d at the import site and re-typed through a local interface.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { openSync as openSyncFn, fstatSync as fstatSyncFn, readSync as readSyncFn, closeSync as closeSyncFn } from "node:fs";
import { getPaths } from "../core/paths.js";
import { openLedger } from "../core/ledger.js";
import { parseEnvelope, type EnvelopeGit } from "../core/envelope.js";
import { resolveAttribution } from "../core/attribution.js";
import { deriveStatus } from "../core/status.js";
import { sliceCompleteLines, assignLineOrdinals, type NodeBuffer } from "./ordinals.js";
import { deriveFootprintPaths, type FootprintCandidateEvent } from "./footprint.js";
import { foldSessionFacets, type FoldableEvent } from "./sessionAggregate.js";
import { extractCommandOutput, claimTestResults } from "./testResults.js";

const openSync = openSyncFn as (path: string, flags: string) => number;
const fstatSync = fstatSyncFn as (fd: number) => { size: number };
const readSync = readSyncFn as (
  fd: number,
  buffer: NodeBuffer,
  offset: number,
  length: number,
  position: number,
) => number;
const closeSync = closeSyncFn as (fd: number) => void;
// Buffer.alloc — a global; re-typed to the NodeBuffer surface this module uses.
declare const Buffer: { alloc(size: number): NodeBuffer };

export interface SkippedLine {
  lineNo: number;
  reason: string;
}

// A structured report, not printed strings (spec "The ingest report") — the
// log command (and later show) renders this without re-deriving anything.
export interface IngestReport {
  eventsInserted: number;
  sessionsTouched: number;
  skipped: SkippedLine[];
  warnings: string[];
}

export interface IngestOptions {
  /** Injectable clock — see docs/issues/ISS-0006.md "Test-harness contract" (staleness cases). */
  now?: () => string;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function extractCwd(eventObj: Record<string, unknown>, fallback: string): string {
  const cwd = eventObj.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : fallback;
}

function emptyBuffer(): NodeBuffer {
  return { indexOf: () => -1, subarray: () => emptyBuffer(), toString: () => "", length: 0 };
}

// Read ONLY the bytes at/after `offset` (spec step 2: "Seek the spool to
// ingested_bytes"). The spool grows unbounded — append forever, no rotation in
// v1 — so reading the whole file on every ingest is O(spool) on the hot read
// path; the HWM cursor exists precisely to make ingest O(new bytes). A `read`
// from the offset never touches the already-ingested prefix.
function readSpoolFrom(spoolPath: string, offset: number): NodeBuffer {
  let fd: number | undefined;
  try {
    fd = openSync(spoolPath, "r");
    const size = fstatSync(fd).size;
    if (offset >= size) return emptyBuffer();
    const length = size - offset;
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, offset + read);
      if (n === 0) break; // truncated under us — take what we got
      read += n;
    }
    return read === length ? buf : buf.subarray(0, read);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return emptyBuffer();
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface ParsedNewLine {
  lineNo: number;
  sessionId: string;
  hookEventName: string;
  ts: string;
  promptId: string | null;
  agentId: string | null;
  agentType: string | null;
  toolUseId: string | null;
  eventText: string;
  eventObj: Record<string, unknown>;
  git?: EnvelopeGit;
}

// Runs the whole algorithm (docs/issues/ISS-0006.md "The ingest algorithm
// (contract)") inside a single transaction: event inserts and the cursor
// advance commit atomically, so a crash rolls back both.
export async function ingest(repoRoot: string, options: IngestOptions = {}): Promise<IngestReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const paths = getPaths(repoRoot);
  const handle = openLedger(paths.ledger);

  try {
    const meta = handle.db.prepare("SELECT ingested_bytes, lines_seen FROM meta WHERE id = 1").get() as {
      ingested_bytes: number;
      lines_seen: number;
    };

    // Read only the tail (bytes >= ingested_bytes); the tail buffer's byte 0
    // IS absolute byte `ingested_bytes`, so slice from 0 and re-anchor the
    // resulting end offset back to absolute for the cursor update.
    const spoolTail = readSpoolFrom(paths.spool, meta.ingested_bytes);
    const { lines: rawLines, endOffset: tailEndOffset } = sliceCompleteLines(spoolTail, 0);
    const endOffset = meta.ingested_bytes + tailEndOffset;
    const ordinals = assignLineOrdinals(meta.lines_seen, rawLines);

    const report: IngestReport = { eventsInserted: 0, sessionsTouched: 0, skipped: [], warnings: [] };
    const parsedLines: ParsedNewLine[] = [];

    for (const { lineNo, text } of ordinals) {
      const parsed = parseEnvelope(text);
      if (!parsed.ok) {
        report.skipped.push({ lineNo, reason: parsed.reason });
        continue;
      }
      if (typeof parsed.event !== "object" || parsed.event === null || Array.isArray(parsed.event)) {
        report.skipped.push({ lineNo, reason: "event member is not a JSON object" });
        continue;
      }
      const eventObj = parsed.event as Record<string, unknown>;
      const sessionId = stringOrNull(eventObj.session_id);
      if (sessionId === null) {
        report.skipped.push({ lineNo, reason: "event is missing a string session_id" });
        continue;
      }
      const hookEventName = stringOrNull(eventObj.hook_event_name);
      if (hookEventName === null) {
        report.skipped.push({ lineNo, reason: "event is missing a string hook_event_name" });
        continue;
      }

      parsedLines.push({
        lineNo,
        sessionId,
        hookEventName,
        ts: parsed.ts,
        promptId: stringOrNull(eventObj.prompt_id),
        agentId: stringOrNull(eventObj.agent_id),
        agentType: stringOrNull(eventObj.agent_type),
        toolUseId: stringOrNull(eventObj.tool_use_id),
        eventText: parsed.eventText,
        eventObj,
        git: parsed.git,
      });
    }

    const existingSessionIds = new Set(
      (handle.db.prepare("SELECT session_id FROM sessions").all() as { session_id: string }[]).map(
        (row) => row.session_id,
      ),
    );

    // Attribution (spec "Attribution") is resolved once per genuinely new
    // session, from the first (lowest line_no) event this run sees for it —
    // an async git shell-out, so it happens before the transaction opens.
    const newSessionCwd = new Map<string, string>();
    for (const line of parsedLines) {
      if (existingSessionIds.has(line.sessionId) || newSessionCwd.has(line.sessionId)) continue;
      newSessionCwd.set(line.sessionId, extractCwd(line.eventObj, repoRoot));
    }
    const attributionBySession = new Map<string, { repoRoot: string; worktreePath: string | null }>();
    for (const [sessionId, cwd] of newSessionCwd) {
      attributionBySession.set(sessionId, await resolveAttribution(cwd, repoRoot));
    }

    handle.db.exec("BEGIN");
    try {
      const insertEventStmt = handle.db.prepare(
        `INSERT INTO events (line_no, session_id, seq, ts, hook_event_name, prompt_id, agent_id, agent_type, tool_use_id, payload)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(line_no) DO NOTHING`,
      );

      const touchedSessionIds = new Set<string>();
      const newEventsBySession = new Map<string, FoldableEvent[]>();

      for (const line of parsedLines) {
        insertEventStmt.run(
          line.lineNo,
          line.sessionId,
          line.ts,
          line.hookEventName,
          line.promptId,
          line.agentId,
          line.agentType,
          line.toolUseId,
          line.eventText,
        );
        report.eventsInserted++;
        touchedSessionIds.add(line.sessionId);

        const bucket = newEventsBySession.get(line.sessionId) ?? [];
        bucket.push({ ts: line.ts, hookEventName: line.hookEventName, eventObj: line.eventObj, git: line.git });
        newEventsBySession.set(line.sessionId, bucket);
      }

      // Sessions: an aggregate, upserted from the delta this run's new
      // events contribute. A brand-new session is INSERTed with the delta
      // as its starting facets; every touched session (new or existing)
      // then gets the COALESCE/MIN/MAX merge, which is a no-op for a row
      // just inserted and a genuine merge for one touched again later — a
      // fact once set (kind, sha_before, sha_after, ended_at) never resets.
      const insertSessionStmt = handle.db.prepare(
        `INSERT OR IGNORE INTO sessions
           (session_id, repo_root, worktree_path, kind, status, sha_before, sha_after, started_at, last_event_at, ended_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      );
      const mergeSessionStmt = handle.db.prepare(
        `UPDATE sessions SET
           kind = COALESCE(kind, ?),
           sha_before = COALESCE(sha_before, ?),
           sha_after = COALESCE(sha_after, ?),
           ended_at = COALESCE(ended_at, ?),
           started_at = MIN(started_at, ?),
           last_event_at = MAX(last_event_at, ?)
         WHERE session_id = ?`,
      );

      for (const sessionId of touchedSessionIds) {
        const events = newEventsBySession.get(sessionId)!;
        const delta = foldSessionFacets(events);

        if (!existingSessionIds.has(sessionId)) {
          const attribution = attributionBySession.get(sessionId) ?? { repoRoot, worktreePath: null };
          insertSessionStmt.run(
            sessionId,
            attribution.repoRoot,
            attribution.worktreePath,
            delta.kind,
            delta.shaBefore,
            delta.shaAfter,
            delta.minTs,
            delta.maxTs,
            delta.endedAt,
          );
        }

        mergeSessionStmt.run(
          delta.kind,
          delta.shaBefore,
          delta.shaAfter,
          delta.endedAt,
          delta.minTs,
          delta.maxTs,
          sessionId,
        );
        report.sessionsTouched++;
      }

      // Footprint: the one materialized facet, recomputed per touched
      // session from the FULL events set now on disk (spec "Facets" — fully
      // rebuildable from `events`), never accumulated incrementally.
      const footprintEventsStmt = handle.db.prepare("SELECT payload FROM events WHERE session_id = ?");
      const deleteFootprintStmt = handle.db.prepare("DELETE FROM footprint WHERE session_id = ?");
      const insertFootprintStmt = handle.db.prepare("INSERT INTO footprint (session_id, path) VALUES (?, ?)");

      for (const sessionId of touchedSessionIds) {
        const rows = footprintEventsStmt.all(sessionId) as { payload: string }[];
        const candidates: FootprintCandidateEvent[] = rows.map((row) => {
          try {
            return JSON.parse(row.payload) as FootprintCandidateEvent;
          } catch {
            return {};
          }
        });
        deleteFootprintStmt.run(sessionId);
        for (const path of deriveFootprintPaths(candidates)) {
          insertFootprintStmt.run(sessionId, path);
        }
      }

      // test_results: the parser-derived test facet (docs/issues/ISS-0018.md).
      // Recomputed per touched session's command events, keyed on the
      // command event's own line_no (identity), ON CONFLICT DO NOTHING so a
      // re-ingest (or a delete-ledger rebuild) never re-derives a row that
      // already exists — deterministic recompute, no row-count drift.
      const testResultEventsStmt = handle.db.prepare(
        "SELECT line_no, hook_event_name, payload FROM events WHERE session_id = ?",
      );
      const insertTestResultStmt = handle.db.prepare(
        `INSERT INTO test_results (line_no, session_id, parser, passed, failed, skipped, duration_ms, failed_names)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(line_no) DO NOTHING`,
      );
      for (const sessionId of touchedSessionIds) {
        const rows = testResultEventsStmt.all(sessionId) as {
          line_no: number;
          hook_event_name: string;
          payload: string;
        }[];
        for (const row of rows) {
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(row.payload) as Record<string, unknown>;
          } catch {
            continue;
          }
          const output = extractCommandOutput(row.hook_event_name, payload);
          if (output === null) continue;
          const claim = claimTestResults(output);
          if (claim === null) continue;
          insertTestResultStmt.run(
            row.line_no,
            sessionId,
            claim.parser,
            claim.result.passed,
            claim.result.failed,
            claim.result.skipped,
            claim.result.durationMs,
            JSON.stringify(claim.result.failedNames),
          );
        }
      }

      // Seq: a per-session presentation ordinal, deterministic in line_no
      // order (spec "Event identity is the spool line ordinal") —
      // recomputed over the full per-session event set for every touched
      // session, so it stays contiguous from 1 across incremental ingest.
      const seqSessionEventsStmt = handle.db.prepare("SELECT line_no FROM events WHERE session_id = ? ORDER BY line_no");
      const updateSeqStmt = handle.db.prepare("UPDATE events SET seq = ? WHERE line_no = ?");
      for (const sessionId of touchedSessionIds) {
        const rows = seqSessionEventsStmt.all(sessionId) as { line_no: number }[];
        rows.forEach((row, index) => updateSeqStmt.run(index + 1, row.line_no));
      }

      // Status: recomputed for ALL sessions every ingest, not only touched
      // ones — wall-clock time alone can flip open -> closed-inferred, and
      // this is never a one-way door (spec "Status").
      const nowIso = now();
      const allSessionsStmt = handle.db.prepare("SELECT session_id, ended_at, last_event_at FROM sessions");
      const updateStatusStmt = handle.db.prepare("UPDATE sessions SET status = ? WHERE session_id = ?");
      const allSessions = allSessionsStmt.all() as {
        session_id: string;
        ended_at: string | null;
        last_event_at: string;
      }[];
      for (const row of allSessions) {
        const status = deriveStatus({
          endedAt: row.ended_at ?? undefined,
          lastEventTs: row.last_event_at,
          now: nowIso,
        });
        updateStatusStmt.run(status, row.session_id);
      }

      handle.db
        .prepare("UPDATE meta SET ingested_bytes = ?, lines_seen = ?, last_ingest_at = ? WHERE id = 1")
        .run(endOffset, meta.lines_seen + rawLines.length, nowIso);

      handle.db.exec("COMMIT");
    } catch (err) {
      handle.db.exec("ROLLBACK");
      throw err;
    }

    return report;
  } finally {
    handle.close();
  }
}
