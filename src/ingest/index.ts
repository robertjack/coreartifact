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
import { openLedger, LedgerPathIsDirectoryError, type LedgerHandle } from "../core/ledger.js";
import { parseSpoolLine, type EnvelopeGit, type CheckFields } from "../core/envelope.js";
import { resolveAttribution } from "../core/attribution.js";
import { deriveStatus } from "../core/status.js";
import { sliceCompleteLines, assignLineOrdinals, type NodeBuffer } from "./ordinals.js";
import { deriveFootprintPaths, type FootprintCandidateEvent } from "./footprint.js";
import { foldSessionFacets, type FoldableEvent } from "./sessionAggregate.js";
import { classifySessionKind, type DriftEvent } from "./drift.js";
import { setAbsence, clearAbsence } from "../core/absence.js";
import { extractCommandOutput, claimTestResults } from "./testResults.js";
import { enrichFromTranscript } from "./enrichment.js";
import { extractBackgroundTaskId } from "../facets/outcome.js";

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
// setTimeout — a global; used only by openLedgerWithRetry's backoff below.
declare function setTimeout(callback: () => void, ms: number): unknown;

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Proven by execution (F119, ISS-0017 round-2 review): openLedger's own
// rebuild-trigger probe (core/ledger.ts's needsRebuild) can misjudge a
// ledger file a CONCURRENT process is still in the middle of first-ever
// creating -- a brand-new file legitimately has zero tables for the instant
// before its creator's `db.exec(SCHEMA_SQL)` lands, and a second process's
// probe reads that instant as "wrong schema" and deletes the file out from
// under the still-writing creator. The creator then fails, and the exact
// SQLite error text observed by execution varied by timing across repeated
// runs -- "database is locked", "attempt to write a readonly database",
// "disk I/O error" -- all the same underlying race (the file disappeared
// mid-write), just different points where SQLite's C layer notices. This
// file owns no part of core/ledger.ts (out of footprint) -- fixing the race
// at its source is a separate slice's job; here, ingest retries the WHOLE
// openLedger call with backoff instead, which needs no ledger-side change:
// on retry, the winning process's file is either fully created (existsSync
// + correct schema, an ordinary open) or fully absent again (this call
// becomes the creator). Enumerating every SQLite error string this race can
// surface is a losing game (proven by execution: the list above grew every
// time this was measured) -- so every openLedger failure is retried EXCEPT
// the one genuinely definitive, non-racy verdict openLedger can return:
// the ledger path is a directory, not a database file. A fleet's worth of
// concurrent first-time `check`/`log` runs is the exact workload this
// exists to serialize instead of crash on.
function isRetryableLedgerOpenError(err: unknown): boolean {
  return !(err instanceof LedgerPathIsDirectoryError);
}

// F124 (ISS-0017 round-4 review, proven by execution): the race described
// above is NOT confined to openLedger()'s own internal window. Measured on
// a fresh repo with 10 concurrent first-ever `check` processes: even after
// wrapping ONLY the `openLedger(dbPath)` call in retry (this function's
// prior shape), a process could still see openLedger() itself RETURN a
// valid-looking handle and then hit "attempt to write a readonly database"
// later, mid-transaction (BEGIN IMMEDIATE or a subsequent insert) -- a
// concurrent SIBLING's own needsRebuild probe can still misjudge and delete
// the file in the wider window between one process's successful open and
// its transaction actually committing, not only during creation itself.
// So the unit that gets retried is the WHOLE open-then-run sequence, using
// a FRESH connection each attempt (the stale one is closed first) -- same
// idempotency argument as before: retrying is always safe because
// runIngestBody re-reads ingested_bytes/lines_seen fresh from whatever
// handle it's given, and openLedger's own rebuild-vs-open logic decides
// from scratch whether the retried attempt is an ordinary open or a
// re-creation.
async function withLedgerRetry<T>(dbPath: string, run: (handle: LedgerHandle) => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 40;
  const RETRY_DELAY_MS = 25;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let handle: LedgerHandle | undefined;
    try {
      handle = openLedger(dbPath);
      return await run(handle);
    } catch (err) {
      if (!isRetryableLedgerOpenError(err)) throw err;
      lastErr = err;
      await delay(RETRY_DELAY_MS);
    } finally {
      // The failed attempt's connection (if it got that far) is never
      // reused across a retry -- a fresh openLedger() call next attempt
      // re-derives the real on-disk state instead of trusting a handle
      // that may be pointed at a file a sibling process just deleted.
      try {
        handle?.close();
      } catch {
        // Closing an already-broken connection can itself throw; the
        // retryable error above is what matters, not this cleanup.
      }
    }
  }
  throw lastErr;
}

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
  // ISS-0024 R14: the backgrounded-outcome join key, promoted from either
  // payload location extractBackgroundTaskId knows about — NULL on every
  // other event.
  backgroundTaskId: string | null;
  eventText: string;
  eventObj: Record<string, unknown>;
  git?: EnvelopeGit;
}

interface ParsedCheckLine {
  lineNo: number;
  ts: string;
  check: CheckFields;
}

// The open-session identity set (F124, ISS-0017 round-4 review): resolved by
// `check`'s binding step. Deliberately just session_id + status -- the
// smallest projection binding needs, read from the SAME connection ingest
// already opened, never a second one.
export interface SessionIdentityRow {
  session_id: string;
  status: string;
}

// Runs the whole algorithm (docs/issues/ISS-0006.md "The ingest algorithm
// (contract)") inside a single transaction: event inserts and the cursor
// advance commit atomically, so a crash rolls back both. `handle` is already
// open on entry and is never closed here -- the caller owns the connection
// lifetime (see `ingest` and `ingestAndResolveSessions` below, the two
// exported entry points that each open exactly one connection for their
// whole lazy-ingest-then-read sequence).
async function runIngestBody(
  repoRoot: string,
  options: IngestOptions,
  handle: LedgerHandle,
): Promise<IngestReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const paths = getPaths(repoRoot);

  {
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
    const parsedChecks: ParsedCheckLine[] = [];

    for (const { lineNo, text } of ordinals) {
      const parsed = parseSpoolLine(text);
      if (!parsed.ok) {
        report.skipped.push({ lineNo, reason: parsed.reason });
        continue;
      }
      if (parsed.kind === "check") {
        parsedChecks.push({ lineNo, ts: parsed.ts, check: parsed.check });
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
        backgroundTaskId: extractBackgroundTaskId(hookEventName, eventObj),
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

    // BEGIN IMMEDIATE, not plain BEGIN (DEFERRED): a DEFERRED transaction
    // starts as a reader and only takes the write lock on its first write,
    // and SQLite returns SQLITE_BUSY on THAT upgrade WITHOUT ever invoking
    // the busy handler -- so openLedger's busy_timeout (see core/ledger.ts)
    // never applies and concurrent ingests die "database is locked" instead
    // of serializing. IMMEDIATE takes the write lock at transaction start,
    // where busy_timeout DOES apply (F119, ISS-0017 round-2 review; the
    // reviewer's executed repro was 10 concurrent `check` processes against
    // one repo, 4/10 crashed under plain BEGIN).
    handle.db.exec("BEGIN IMMEDIATE");
    try {
      const insertEventStmt = handle.db.prepare(
        `INSERT INTO events (line_no, session_id, seq, ts, hook_event_name, prompt_id, agent_id, agent_type, tool_use_id, background_task_id, payload)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
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
          line.backgroundTaskId,
          line.eventText,
        );
        report.eventsInserted++;
        touchedSessionIds.add(line.sessionId);

        const bucket = newEventsBySession.get(line.sessionId) ?? [];
        bucket.push({ ts: line.ts, hookEventName: line.hookEventName, eventObj: line.eventObj, git: line.git });
        newEventsBySession.set(line.sessionId, bucket);
      }

      // Checks: the second `v: 1` spool variant (spec "Ingest routing").
      // Every field projects verbatim from the frozen spool line, including
      // `session_id`/`bound_by` -- ingest never re-resolves a binding
      // `check` already decided at write time. Check lines consume line_no
      // ordinals from the same sequence as event lines (already true above,
      // since ordinals are assigned per physical line regardless of kind).
      const insertCheckStmt = handle.db.prepare(
        `INSERT INTO checks (line_no, ts, name, argv, exit_code, output, truncated, session_id, bound_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(line_no) DO NOTHING`,
      );
      for (const line of parsedChecks) {
        insertCheckStmt.run(
          line.lineNo,
          line.ts,
          line.check.name,
          JSON.stringify(line.check.argv),
          line.check.exit,
          line.check.output,
          line.check.truncated ? 1 : 0,
          line.check.session_id,
          line.check.bound_by,
        );
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

      // Drift detector (docs/issues/ISS-0020.md): recomputed per touched
      // session from the FULL events set now on disk — the same pattern as
      // footprint below, and for the same reason (idempotent, rebuildable
      // from the spool). This is the authoritative kind classification;
      // it overwrites whatever the delta-fold above set, because only a
      // full-session view can see the SessionEnd reason needed for rule 3.
      const kindEventsStmt = handle.db.prepare(
        "SELECT hook_event_name, payload FROM events WHERE session_id = ?",
      );
      const updateKindStmt = handle.db.prepare("UPDATE sessions SET kind = ? WHERE session_id = ?");

      for (const sessionId of touchedSessionIds) {
        const rows = kindEventsStmt.all(sessionId) as { hook_event_name: string; payload: string }[];
        const driftEvents: DriftEvent[] = rows.map((row) => {
          let eventObj: unknown;
          try {
            eventObj = JSON.parse(row.payload);
          } catch {
            eventObj = null;
          }
          return { hookEventName: row.hook_event_name, eventObj };
        });

        const classification = classifySessionKind(driftEvents);
        updateKindStmt.run(classification.kind, sessionId);
        if (classification.kind === null) {
          setAbsence(handle.db, sessionId, "kind", classification.reason);
        } else {
          clearAbsence(handle.db, sessionId, "kind");
        }
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

      // Cost enrichment (docs/issues/ISS-0019.md): the one transcript-derived
      // facet, recomputed per touched session from the FULL events set now
      // on disk -- same recompute-from-full-history stance as kind/footprint
      // above, so a rebuild from spool + transcript-at-path always
      // reproduces it, and a delete-ledger + re-ingest after the transcript
      // appears (or the price table gains the model) retroactively regains
      // the facet. The transcript path itself is read from the session's own
      // recorded payload (every hook event carries `transcript_path`), never
      // guessed or cached -- and the transcript file is opened read-only by
      // enrichFromTranscript, never copied (law).
      const enrichmentEventsStmt = handle.db.prepare("SELECT payload FROM events WHERE session_id = ?");
      const updateEnrichmentStmt = handle.db.prepare(
        `UPDATE sessions SET
           tokens_input = ?, tokens_output = ?, tokens_cache_read = ?, tokens_cache_creation = ?,
           cost_usd = ?, model = ?, cc_version = ?
         WHERE session_id = ?`,
      );

      for (const sessionId of touchedSessionIds) {
        const rows = enrichmentEventsStmt.all(sessionId) as { payload: string }[];
        let transcriptPath: string | null = null;
        for (const row of rows) {
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(row.payload) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof payload.transcript_path === "string" && payload.transcript_path.length > 0) {
            transcriptPath = payload.transcript_path;
            break;
          }
        }

        const enrichment = enrichFromTranscript(transcriptPath);
        updateEnrichmentStmt.run(
          enrichment.tokensInput,
          enrichment.tokensOutput,
          enrichment.tokensCacheRead,
          enrichment.tokensCacheCreation,
          enrichment.costUsd,
          enrichment.model,
          enrichment.ccVersion,
          sessionId,
        );

        if (enrichment.costAbsenceReason !== null) {
          setAbsence(handle.db, sessionId, "cost", enrichment.costAbsenceReason);
        } else {
          clearAbsence(handle.db, sessionId, "cost");
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
  }
}

// Lazy-ingest entry point for a plain read (`log`'s current shape): the
// whole open-then-run sequence retries as one unit (see withLedgerRetry).
export async function ingest(repoRoot: string, options: IngestOptions = {}): Promise<IngestReport> {
  const paths = getPaths(repoRoot);
  return withLedgerRetry(paths.ledger, (handle) => runIngestBody(repoRoot, options, handle));
}

// Lazy-ingest entry point for `check`'s binding step (F124, ISS-0017
// round-4 review). Before this existed, `check` called `ingest` (which
// opens-and-closes its own connection) and THEN opened a second, separate
// readOnly connection to resolve the open-session set -- a second race
// window against the exact first-creation race `openLedgerWithRetry` exists
// to serialize (see the block comment above), unprotected by any retry.
// This instead keeps ingest's own connection open just long enough to also
// read the session identity set, so the whole lazy-ingest-then-read
// sequence is ONE connection, ONE race window, already covered by the
// retry loop above.
export async function ingestAndResolveSessions(
  repoRoot: string,
  options: IngestOptions = {},
): Promise<{ report: IngestReport; sessions: SessionIdentityRow[] }> {
  const paths = getPaths(repoRoot);
  return withLedgerRetry(paths.ledger, async (handle) => {
    const report = await runIngestBody(repoRoot, options, handle);
    const sessions = handle.db.prepare("SELECT session_id, status FROM sessions").all() as SessionIdentityRow[];
    return { report, sessions };
  });
}
