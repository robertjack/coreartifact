// ISS-0018 acceptance tests — the vitest parser + ingest recompute + show's
// test-results badge (docs/issues/ISS-0018.md).
//
// Test-harness contract: reuses the acceptance harness's primitives verbatim
// from ../harness/index.js (tmpdir-repo factory, CLI runner, fixture
// replayer, readLedger for sessions/events/footprint). The vitest scenario
// is loaded by name through the fixtures issue's typed loader
// (../../fixtures/loader.js) rather than a hand-wired path.
//
// No module owned by this issue (src/parsers/**, the ingest recompute
// extension, show's new badge line) is imported directly: every assertion
// below drives the built CLI as a subprocess and inspects either its
// stdout or the ledger's `test_results`/`absences` tables — the public
// seams the spec names. `openLedger`, `TestResultRow` and `EventRow` are
// already-shipped exports of src/core/ledger.ts (ISS-0013); `getAllAbsences`
// and `AbsenceRow` are already-shipped exports of src/core/absence.ts
// (ISS-0014). None of these are "the module under test," so they are
// imported statically rather than through a try/catch dynamic import.
//
// There is no dedicated "test-results row reader" function exported
// anywhere in the repo today (only the TestResultRow *type* + openLedger
// exist) — ISS-0013's own spec called for one but the merged code stops at
// the type. readTestResultsRows() below fills that gap locally, inside
// this issue's own footprint, using the officially exported TestResultRow
// shape to type a plain `db.prepare(...).all()` query — the same style
// ../harness/readers.ts already uses for sessions/events/footprint.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import {
  createTmpRepo,
  runCli,
  readLedger,
  type TmpRepo,
} from "../harness/index.js";
import { loadFixtureStream } from "../../fixtures/loader.js";
import { getPaths } from "../../../src/core/paths.js";
import { openLedger, type TestResultRow, type EventRow } from "../../../src/core/ledger.js";
import { getAllAbsences, type AbsenceRow } from "../../../src/core/absence.js";

interface RawHookResult {
  exitCode: number;
}

// A single raw invocation of the installed hook command with caller-supplied
// stdin bytes — needed to inject synthetic-but-realistic payload variants
// (a zero-tests vitest summary, a summary with no Duration line) that the
// recorded fixture stream does not itself contain. Mirrors ISS-0007/
// ISS-0008's own `runRawHookInvocation` helper.
function runRawHookInvocation(command: string[], stdinText: string): Promise<RawHookResult> {
  const [cmd, ...args] = command;
  if (!cmd) throw new Error("runRawHookInvocation: empty command");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ exitCode: code ?? -1 });
    });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

// Rebases EVERY line's `cwd` onto a live repo before replay — a stricter
// version of ISS-0008's own `rebaseBoundaryCwdOntoRepo`, which only touched
// SessionStart/SessionEnd. capture.ts's resolveRepoRoot(cwd, initRoot) runs
// per EVENT, not just per boundary event: on this machine (the very box the
// vitest fixture was recorded on), the recorded cwd
// (.../scratchpad/vitest-repo) is a real, still-present git repo, so an
// un-rebased replay resolves repo root to THAT leftover directory instead of
// this test's own tmp repo and silently writes the spool line there —
// nothing lands in `paths.spool` at all (verified by execution: the plain
// headless fixture's recorded cwd is dead on this machine and needs no
// rebase, but vitest's is not). Every other field stays exactly as recorded.
function rebaseCwdOntoRepo(lines: string[], repoRoot: string): string[] {
  return lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    parsed.cwd = repoRoot;
    return JSON.stringify(parsed);
  });
}

// Sequentially replays already-loaded (and possibly rebased) fixture lines
// through the installed hook command, one invocation per line, in order —
// mirrors the harness's own replayFixtures but over caller-supplied lines.
async function replayLinesThroughHook(lines: string[], command: string[]): Promise<void> {
  for (const line of lines) {
    const result = await runRawHookInvocation(command, line);
    expect(result.exitCode, "a hook invocation of a rebased fixture line did not exit 0").toBe(0);
  }
}

function sessionIdOf(fixtureLine: string): string {
  const parsed = JSON.parse(fixtureLine) as { session_id?: unknown };
  if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) {
    throw new Error("test setup invariant: fixture line has no session_id");
  }
  return parsed.session_id;
}

// Rewrites only `session_id` on a fixture line's JSON — used to graft the
// vitest fixture's SessionStart/SessionEnd boundary lines onto a synthetic
// session id without touching any other recorded field.
function withSessionId(templateLine: string, sessionId: string): string {
  const parsed = JSON.parse(templateLine) as Record<string, unknown>;
  parsed.session_id = sessionId;
  return JSON.stringify(parsed);
}

// Clones the vitest fixture's recorded PostToolUse (passing) line, swapping
// only session/tool-use identity, the Bash command string and the captured
// stdout text — the two payload fields R4/criterion-4 need varied to reach
// the zero-tests and duration-unextractable branches no recorded fixture
// line exercises. Every other field (hook_event_name, cwd, transcript_path,
// permission_mode, ...) stays exactly as recorded.
function buildSyntheticPostToolUse(
  templateLine: string,
  overrides: { sessionId: string; toolUseId: string; command: string; stdout: string },
): string {
  const parsed = JSON.parse(templateLine) as Record<string, unknown>;
  parsed.session_id = overrides.sessionId;
  parsed.tool_use_id = overrides.toolUseId;
  parsed.tool_input = { ...(parsed.tool_input as Record<string, unknown>), command: overrides.command };
  parsed.tool_response = { ...(parsed.tool_response as Record<string, unknown>), stdout: overrides.stdout };
  return JSON.stringify(parsed);
}

// Finds the line_no of the one event, for the given session's events, whose
// hook_event_name matches and whose tool_input.command contains the given
// substring — the identity key test_results rows are keyed on (spec: "the
// facet's identity is the command event's spool ordinal").
function findCommandLineNo(events: EventRow[], hookEventName: string, commandSubstring: string): number {
  const match = events.find((event) => {
    if (event.hook_event_name !== hookEventName) return false;
    const payload = JSON.parse(event.payload) as { tool_input?: { command?: unknown } };
    return typeof payload.tool_input?.command === "string" && payload.tool_input.command.includes(commandSubstring);
  });
  if (!match) {
    throw new Error(
      `test setup invariant: no ${hookEventName} event found for a command containing "${commandSubstring}"`,
    );
  }
  return match.line_no;
}

// Finds a rendered line containing ALL of `tokens` together — the only
// reliable way to pick out one specific timeline entry when a token (a
// command string) could otherwise also appear, alone, in an unrelated line
// (e.g. the session's own prompt text). Mirrors ISS-0007/ISS-0008's own
// `findLineWithAll`.
function findLineWithAll(output: string, tokens: string[]): string {
  const matches = output.split("\n").filter((line) => tokens.every((t) => line.includes(t)));
  expect(
    matches.length,
    `expected at least one rendered line containing all of ${JSON.stringify(tokens)}, found none. Full output:\n${output}`,
  ).toBeGreaterThanOrEqual(1);
  return matches[0]!;
}

async function ingestViaLog(repo: TmpRepo): Promise<void> {
  const logResult = await runCli(["log"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
  expect(
    logResult.exitCode,
    `test setup invariant: log (used to trigger ingest) did not exit 0; stderr: ${logResult.stderr}`,
  ).toBe(0);
}

function readTestResultsRows(ledgerPath: string): TestResultRow[] {
  const handle = openLedger(ledgerPath);
  try {
    return handle.db.prepare("SELECT * FROM test_results ORDER BY line_no").all() as TestResultRow[];
  } finally {
    handle.close();
  }
}

function readAllAbsences(ledgerPath: string): AbsenceRow[] {
  const handle = openLedger(ledgerPath);
  try {
    return getAllAbsences(handle.db);
  } finally {
    handle.close();
  }
}

describe("ISS-0018 parser interface + the vitest parser", () => {
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it(
    "R4 Parser interface, vitest first. Test-output parsing sits behind a pluggable interface at ingest (never in the hook artifact); exactly one parser ships. For a session whose recorded stream contains a real vitest run: the session gains a test-results facet with pass/fail/skip counts, failed test names, and duration, rendered in show. A command no parser claims records no test-results facet — distinguishable from a vitest run reporting zero tests (degradation law).",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const init = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];

      const vitestLines = loadFixtureStream("vitest");
      const vitestSessionId = sessionIdOf(vitestLines[0]!);
      await replayLinesThroughHook(rebaseCwdOntoRepo(vitestLines, repo.root), command);

      const headlessLines = loadFixtureStream("headless");
      const headlessSessionId = sessionIdOf(headlessLines[0]!);
      await replayLinesThroughHook(rebaseCwdOntoRepo(headlessLines, repo.root), command);

      await ingestViaLog(repo);

      const ledgerSnapshot = readLedger(paths.ledger);
      const passingLineNo = findCommandLineNo(
        ledgerSnapshot.events.filter((e) => e.session_id === vitestSessionId),
        "PostToolUse",
        "pnpm vitest run passing.test.js",
      );
      const nonTestLineNo = findCommandLineNo(
        ledgerSnapshot.events.filter((e) => e.session_id === headlessSessionId),
        "PostToolUse",
        "echo capture-ok",
      );

      const testResultsRows = readTestResultsRows(paths.ledger);

      const passingRow = testResultsRows.find((r) => r.line_no === passingLineNo);
      expect(
        passingRow,
        `expected a test-results row for the passing vitest command (line_no ${passingLineNo}, recorded fixture summary "Tests  2 passed (2)"); rows present: ${JSON.stringify(testResultsRows)}`,
      ).toBeDefined();
      expect(passingRow!.passed).toBe(2);
      expect(passingRow!.failed).toBe(0);
      expect(passingRow!.skipped).toBe(0);
      expect(JSON.parse(passingRow!.failed_names)).toEqual([]);

      const nonTestRow = testResultsRows.find((r) => r.line_no === nonTestLineNo);
      expect(
        nonTestRow,
        "a non-test Bash command (echo capture-ok) unclaimed by any parser must record no test-results row",
      ).toBeUndefined();

      const showResult = await runCli(["show", vitestSessionId], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(showResult.exitCode, `show did not exit 0; stderr: ${showResult.stderr}`).toBe(0);

      // The passing command's outcome renders as the literal "success" today
      // with no mention of test counts/duration at all — unlike the failing
      // command, whose raw error text (already rendered verbatim by the
      // existing outcome facet) happens to embed the same numbers a badge
      // would show. "65" (the vitest-reported duration, from the fixture's
      // own "Duration  65ms" summary line) can only appear on the passing
      // command's rendered line once a new test-results badge exists.
      // Operator amendment 2026-07-16 (test_dispute): the single-token match
      // resolved to the earlier UserPromptSubmit line — the fixture's prompt
      // text literally embeds the command string — not the command's own
      // rendered line. "command:" is the command-entry render prefix
      // (src/render/show.ts), which prompt lines never carry.
      const passingLine = findLineWithAll(showResult.stdout, ["command:", "pnpm vitest run passing.test.js"]);
      expect(
        passingLine,
        `expected the passing command's rendered line to carry its parsed vitest duration (65ms) as a test-results badge. Line: ${passingLine}`,
      ).toContain("65");
    },
  );

  it(
    "The vitest parser reads both recorded payload paths: a passing run parsed from the PostToolUse tool_response stdout text, and a failing run parsed from the PostToolUseFailure error string after the Exit code 1 marker (that event carries no tool_response), with the failed test names extracted from the error string.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const init = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];

      const vitestLines = loadFixtureStream("vitest");
      const sessionId = sessionIdOf(vitestLines[0]!);
      await replayLinesThroughHook(rebaseCwdOntoRepo(vitestLines, repo.root), command);
      await ingestViaLog(repo);

      const events = readLedger(paths.ledger).events.filter((e) => e.session_id === sessionId);
      const passingLineNo = findCommandLineNo(events, "PostToolUse", "pnpm vitest run passing.test.js");
      const failingLineNo = findCommandLineNo(events, "PostToolUseFailure", "pnpm vitest run");

      // Ground truth for "that event carries no tool_response" (spec) —
      // confirms this test is actually exercising the error-string path,
      // not accidentally reading a tool_response that isn't there.
      const failingEvent = events.find((e) => e.line_no === failingLineNo)!;
      const failingPayload = JSON.parse(failingEvent.payload) as Record<string, unknown>;
      expect(
        failingPayload.tool_response,
        "test setup invariant: the recorded PostToolUseFailure event must carry no tool_response",
      ).toBeUndefined();
      expect(
        typeof failingPayload.error === "string" && failingPayload.error.startsWith("Exit code 1\n\n"),
        "test setup invariant: the recorded PostToolUseFailure event's error string must carry the Exit code 1 marker the parser strips",
      ).toBe(true);

      const rows = readTestResultsRows(paths.ledger);
      const passingRow = rows.find((r) => r.line_no === passingLineNo);
      const failingRow = rows.find((r) => r.line_no === failingLineNo);

      expect(
        passingRow,
        `expected a test-results row keyed on the PostToolUse event's own line_no (${passingLineNo}), parsed from tool_response.stdout`,
      ).toBeDefined();
      expect(passingRow!.passed).toBe(2);
      expect(passingRow!.failed).toBe(0);

      expect(
        failingRow,
        `expected a test-results row keyed on the PostToolUseFailure event's own line_no (${failingLineNo}), parsed from the error string after the Exit code 1 marker`,
      ).toBeDefined();
      expect(failingRow!.passed).toBe(3);
      expect(failingRow!.failed).toBe(1);
      expect(
        JSON.parse(failingRow!.failed_names),
        "failed test names must be extracted from the error string",
      ).toEqual(["subtracts (deliberately red for the fixture)"]);
    },
  );

  it(
    "Replaying the vitest fixture stream yields a test-results facet matching the recorded run: 4 tests with 1 failed, the failed test named subtracts (deliberately red for the fixture), and a parsed duration; the facet's identity is the command event's spool ordinal, so deleting the ledger and re-ingesting rebuilds an equivalent test-results row.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const init = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];

      const vitestLines = loadFixtureStream("vitest");
      const sessionId = sessionIdOf(vitestLines[0]!);
      await replayLinesThroughHook(rebaseCwdOntoRepo(vitestLines, repo.root), command);
      await ingestViaLog(repo);

      const events = readLedger(paths.ledger).events.filter((e) => e.session_id === sessionId);
      // The recorded run's own summary ("Test Files  1 failed | 1 passed
      // (2)" / "Tests  1 failed | 3 passed (4)") is the suite-level total
      // pinned in the transcripts manifest's suite metadata (2 files, 4
      // tests, 1 failed) — it lives on the PostToolUseFailure event.
      const failingLineNo = findCommandLineNo(events, "PostToolUseFailure", "pnpm vitest run");

      const rowsBefore = readTestResultsRows(paths.ledger);
      const before = rowsBefore.find((r) => r.line_no === failingLineNo);
      expect(
        before,
        `expected a test-results row for the failing vitest command matching the recorded run (4 tests, 1 failed) at line_no ${failingLineNo}`,
      ).toBeDefined();
      expect(before!.line_no, "the facet's identity is the command event's own spool ordinal").toBe(failingLineNo);
      expect(before!.passed).toBe(3);
      expect(before!.failed).toBe(1);
      expect(before!.skipped).toBe(0);
      expect(JSON.parse(before!.failed_names)).toEqual(["subtracts (deliberately red for the fixture)"]);
      expect(before!.duration_ms, "expected a parsed duration, not absent").not.toBeNull();

      rmSync(paths.ledger, { force: true });
      await ingestViaLog(repo);

      const rowsAfter = readTestResultsRows(paths.ledger);
      const after = rowsAfter.find((r) => r.line_no === failingLineNo);
      expect(
        after,
        "deleting the ledger and re-ingesting from the untouched spool must rebuild a test-results row at the same line_no",
      ).toBeDefined();
      expect(after, "the rebuilt row must be equivalent (same line_no, same fields) to the one before deletion").toEqual(
        before,
      );
    },
  );

  it(
    "A parser returning null leaves no test-results row and no absence record — a non-test command is not a degraded facet; a claimed run reporting zero tests stores a row with zero counts, and duration is NULL only when the parser could not extract it, distinct from zero.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const init = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];

      // -- a non-test command, unclaimed by any parser. --
      const headlessLines = loadFixtureStream("headless");
      const headlessSessionId = sessionIdOf(headlessLines[0]!);
      await replayLinesThroughHook(rebaseCwdOntoRepo(headlessLines, repo.root), command);

      // -- a synthetic session exercising the two branches no recorded
      // fixture line reaches: a claimed run reporting zero tests, and a
      // claimed run whose captured output has no Duration line at all.
      // "Tests  0 passed (0)" is the literal zero-tests summary shape the
      // spec itself names; the second stdout is the first's own recorded
      // passing summary with its Duration line simply absent, standing in
      // for a captured output the parser could not extract a duration from.
      const vitestLines = loadFixtureStream("vitest");
      const syntheticSessionId = "iss18-r4-null-degradation-session";
      const startLine = withSessionId(vitestLines[0]!, syntheticSessionId);
      const zeroTestsLine = buildSyntheticPostToolUse(vitestLines[3]!, {
        sessionId: syntheticSessionId,
        toolUseId: "toolu-iss18-zero-tests",
        command: "pnpm vitest run zero.test.js",
        stdout:
          " Test Files  1 passed (1)\n      Tests  0 passed (0)\n   Duration  12ms (transform 1ms, setup 0ms, import 1ms, tests 0ms, environment 0ms)",
      });
      const durationAbsentLine = buildSyntheticPostToolUse(vitestLines[3]!, {
        sessionId: syntheticSessionId,
        toolUseId: "toolu-iss18-duration-absent",
        command: "pnpm vitest run duration-unextractable.test.js",
        stdout: " Test Files  1 passed (1)\n      Tests  2 passed (2)",
      });
      const endLine = withSessionId(vitestLines[7]!, syntheticSessionId);

      const syntheticLines = rebaseCwdOntoRepo(
        [startLine, zeroTestsLine, durationAbsentLine, endLine],
        repo.root,
      );
      await replayLinesThroughHook(syntheticLines, command);

      await ingestViaLog(repo);

      const ledgerSnapshot = readLedger(paths.ledger);
      const nonTestLineNo = findCommandLineNo(
        ledgerSnapshot.events.filter((e) => e.session_id === headlessSessionId),
        "PostToolUse",
        "echo capture-ok",
      );
      const syntheticEvents = ledgerSnapshot.events.filter((e) => e.session_id === syntheticSessionId);
      const zeroTestsLineNo = findCommandLineNo(syntheticEvents, "PostToolUse", "pnpm vitest run zero.test.js");
      const durationAbsentLineNo = findCommandLineNo(
        syntheticEvents,
        "PostToolUse",
        "pnpm vitest run duration-unextractable.test.js",
      );

      const rows = readTestResultsRows(paths.ledger);

      const nonTestRow = rows.find((r) => r.line_no === nonTestLineNo);
      expect(
        nonTestRow,
        "a non-test Bash command unclaimed by any parser must record no test-results row",
      ).toBeUndefined();

      const allAbsences = readAllAbsences(paths.ledger);
      expect(
        allAbsences.some((a) => a.session_id === headlessSessionId && a.facet.toLowerCase().includes("test")),
        "no absence record may be written for an unclaimed non-test command — row membership already encodes absence",
      ).toBe(false);

      const zeroTestsRow = rows.find((r) => r.line_no === zeroTestsLineNo);
      expect(
        zeroTestsRow,
        'expected a claimed test-results row with zero counts for a vitest run reporting "Tests  0 passed (0)"',
      ).toBeDefined();
      expect(zeroTestsRow!.passed).toBe(0);
      expect(zeroTestsRow!.failed).toBe(0);
      expect(zeroTestsRow!.skipped).toBe(0);
      expect(JSON.parse(zeroTestsRow!.failed_names)).toEqual([]);
      expect(
        zeroTestsRow!.duration_ms,
        "a claimed zero-tests run with a parsed Duration line must not report duration as NULL",
      ).not.toBeNull();

      const durationAbsentRow = rows.find((r) => r.line_no === durationAbsentLineNo);
      expect(
        durationAbsentRow,
        "expected a claimed test-results row even though the captured output has no Duration line",
      ).toBeDefined();
      expect(durationAbsentRow!.passed).toBe(2);
      expect(durationAbsentRow!.failed).toBe(0);
      expect(
        durationAbsentRow!.duration_ms,
        "duration must be NULL when the parser could not extract it — distinct from a real zero",
      ).toBeNull();
    },
  );
});
