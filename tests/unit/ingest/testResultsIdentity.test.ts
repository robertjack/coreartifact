// Unit test for the test_results identity key (fix-mode adversarial review
// F-B, ISS-0018): test_results MUST be keyed on the command event's own
// line_no (the spool ordinal — the facet's stated identity, spec "the
// facet's identity is the command event's spool ordinal"), never on seq
// (the per-session presentation ordinal computed later in the same ingest
// run). The shipped fixture happens to have seq === line_no for every
// event throughout, so a mutant that keys the upsert on seq passes the
// fixture-driven acceptance suite unnoticed.
//
// This test manufactures the divergence directly: a corrupt spool line
// (the same "{this is not valid JSON}" shape ordinals.test.ts uses)
// injected between two real events. A corrupt line still consumes its own
// spool ordinal (line_no) but is never inserted into `events`, so every
// event after it gets a line_no one higher than its seq (its 1-based
// position among the session's successfully-parsed events) for the rest of
// the session.
//
// Below the seam: drives `ingest()` directly against a hand-authored
// spool file (same legitimate pattern as statusRecompute.test.ts — this is
// testing ingest's own identity-key behavior, not the hook artifact).
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore -- node:sqlite has no ambient types available in this sandbox (see src/core/ledger.ts)
import { DatabaseSync } from "node:sqlite";
import { ingest } from "../../../src/ingest/index.js";
import { getPaths } from "../../../src/core/paths.js";

function envelopeLine(ts: string, event: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, ts, event })}\n`;
}

const CORRUPT_LINE = "{this is not valid JSON}\n";

interface EventIdentityRow {
  line_no: number;
  seq: number;
}

function readEventIdentity(ledgerPath: string, sessionId: string, command: string): EventIdentityRow {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT line_no, seq, payload FROM events WHERE session_id = ? AND hook_event_name = 'PostToolUse'")
      .all(sessionId) as { line_no: number; seq: number; payload: string }[];
    const match = rows.find((row) => (JSON.parse(row.payload) as { tool_input?: { command?: string } }).tool_input?.command === command);
    if (!match) throw new Error(`no PostToolUse event found for command "${command}"`);
    return { line_no: match.line_no, seq: match.seq };
  } finally {
    db.close();
  }
}

interface TestResultsLookup {
  atLineNo: { passed: number; failed: number } | null;
  atSeq: { passed: number; failed: number } | null;
}

function readTestResultsAt(ledgerPath: string, lineNo: number, seq: number): TestResultsLookup {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    const atLineNoRow = db.prepare("SELECT passed, failed FROM test_results WHERE line_no = ?").get(lineNo) as
      | { passed: number; failed: number }
      | undefined;
    const atSeqRow = db.prepare("SELECT passed, failed FROM test_results WHERE line_no = ?").get(seq) as
      | { passed: number; failed: number }
      | undefined;
    return { atLineNo: atLineNoRow ?? null, atSeq: atSeqRow ?? null };
  } finally {
    db.close();
  }
}

describe("ingest: test_results identity is line_no, not seq", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRepoRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iss0018-testresults-identity-unit-"));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".coreartifact"), { recursive: true });
    return dir;
  }

  it("keys the test_results row at the command event's line_no even after a corrupt spool line has shifted line_no away from seq", async () => {
    const repoRoot = makeRepoRoot();
    const paths = getPaths(repoRoot);
    const sessionId = "unit-testresults-identity";
    const command = "pnpm vitest run passing.test.js";
    const ts = "2026-07-16T00:00:00.000Z";

    const passingStdout =
      " Test Files  1 passed (1)\n      Tests  2 passed (2)\n   Duration  65ms (transform 6ms, setup 0ms, import 10ms, tests 1ms, environment 0ms)";

    const lines =
      envelopeLine(ts, { session_id: sessionId, cwd: repoRoot, hook_event_name: "SessionStart" }) +
      envelopeLine(ts, { session_id: sessionId, cwd: repoRoot, hook_event_name: "UserPromptSubmit" }) +
      envelopeLine(ts, {
        session_id: sessionId,
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }) +
      // The corrupt line: occupies a spool ordinal but is never inserted
      // into `events` — everything after it gets line_no > seq for the
      // rest of this session.
      CORRUPT_LINE +
      envelopeLine(ts, {
        session_id: sessionId,
        cwd: repoRoot,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: passingStdout, stderr: "" },
      }) +
      envelopeLine(ts, { session_id: sessionId, cwd: repoRoot, hook_event_name: "Stop" }) +
      envelopeLine(ts, { session_id: sessionId, cwd: repoRoot, hook_event_name: "SessionEnd", reason: "other" });

    fs.writeFileSync(paths.spool, lines);
    await ingest(repoRoot, { now: () => ts });

    const identity = readEventIdentity(paths.ledger, sessionId, command);
    // Ground truth for the divergence itself — if this fails, the test
    // setup did not actually produce a line_no/seq split and the rest of
    // the assertions below would be vacuous.
    expect(
      identity.line_no,
      "test setup invariant: the corrupt line must shift line_no away from seq for the command event",
    ).not.toBe(identity.seq);
    expect(identity.line_no).toBe(5);
    expect(identity.seq).toBe(4);

    const lookup = readTestResultsAt(paths.ledger, identity.line_no, identity.seq);
    expect(
      lookup.atLineNo,
      "the test_results row must be keyed at the command event's own line_no (its spool ordinal, the facet's stated identity)",
    ).not.toBeNull();
    expect(lookup.atLineNo!.passed).toBe(2);
    expect(lookup.atLineNo!.failed).toBe(0);

    // The badge attaches to the RIGHT command: a lookup at the command's
    // seq value (rather than its line_no) must find nothing — proving the
    // row did not land under the wrong ordinal.
    expect(
      lookup.atSeq,
      "a lookup keyed on seq instead of line_no must find no row — a seq-keyed upsert would misattach the badge",
    ).toBeNull();
  });
});
