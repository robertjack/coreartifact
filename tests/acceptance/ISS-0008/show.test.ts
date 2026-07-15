// ISS-0008 acceptance tests — `show`: the flat timeline, and the three-state
// outcome (docs/issues/ISS-0008.md).
//
// Test-harness contract: reuses the acceptance harness's primitives verbatim
// from ../harness/index.js (tmpdir-repo factory with its isolated registry,
// CLI runner, fixture replayer, worktree helper, readLedger). Also imports
// already-shipped, independent modules as oracles rather than guessing their
// output shape: src/core/paths.js (getPaths), src/core/ledger.js (SessionRow/
// FootprintRow — the row shapes the ledger's schema already fixes) and
// src/render/absent.js (ABSENT_MARKER — the one shared token every ABSENT
// facet must render through, per spec "The absent marker (shared surface)").
//
// Module under test: `show <session>` (src/cli/commands/show.ts, not yet
// registered — src/cli/index.ts currently stubs it as notImplemented("show"))
// plus the facet-derivation module this issue owns. Every test below drives
// the built CLI subprocess (runCli) and asserts on its stdout/stderr — the
// public interface the spec names as the seam — never by importing the
// not-yet-existing renderer/derivation modules directly.
//
// The headless fixture's UserPromptSubmit prompt text spells out every
// command it goes on to run ("1) Run the bash command: echo capture-ok. 2)
// ... 3) Run the bash command: sleep 90 ..."), so a plain single-token
// substring search for a command string can land on the PROMPT line instead
// of the command's own outcome line. Every per-command lookup below requires
// BOTH the command string AND a fact only the real event line can carry
// (its duration, its ABSENT marker, its verbatim error) in the SAME line —
// that combination cannot appear in the prompt text, so it unambiguously
// selects the real line.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import {
  createTmpRepo,
  runCli,
  replayFixtures,
  readLedger,
  type TmpRepo,
} from "../harness/index.js";
import { loadFixtureStream } from "../../fixtures/loader.js";
import { getPaths } from "../../../src/core/paths.js";
import { ABSENT_MARKER } from "../../../src/render/absent.js";

interface RawHookResult {
  exitCode: number;
}

// A single raw invocation of the installed hook command with caller-supplied
// stdin bytes — needed to inject a session missing its SessionStart line.
// Mirrors ISS-0006/ISS-0007's own `runRawHookInvocation` helper.
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

function sessionIdOf(fixtureLine: string): string {
  const parsed = JSON.parse(fixtureLine) as { session_id?: unknown };
  if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) {
    throw new Error("test setup invariant: fixture line has no session_id");
  }
  return parsed.session_id;
}

// Finds a rendered line naming exactly the given session (by a prefix of its
// session_id, standing in for "short id" without pinning an exact truncation
// length the renderer is free to choose). Mirrors ISS-0007's own
// `findSessionLine`.
function findSessionLine(output: string, sessionId: string): string {
  const shortIdToken = sessionId.slice(0, 6);
  const matches = output.split("\n").filter((line) => line.includes(shortIdToken));
  expect(
    matches.length,
    `expected exactly one rendered line naming session ${sessionId}, found: ${JSON.stringify(matches)}`,
  ).toBe(1);
  return matches[0]!;
}

// Finds a rendered line containing ALL of `tokens` together — the only
// reliable way to pick out a specific timeline entry (e.g. a command's
// outcome line) when one of the tokens (a command string) also appears,
// alone, in unrelated lines such as the session's prompt text.
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

describe("ISS-0008 show: the flat timeline, and the three-state outcome", () => {
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it(
    "R11 Show. show <session> prints a flat chronological timeline - lifecycle events, prompts, every command with outcome + duration, subagent events with agent id/type - headed by shas and footprint. An unknown session id exits nonzero with an error naming the id.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(initResult.exitCode, `test setup invariant: init did not exit 0; stderr: ${initResult.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];
      const headlessLines = loadFixtureStream("headless");
      await replayFixtures("headless", command);
      const sessionId = sessionIdOf(headlessLines[0]!);

      await ingestViaLog(repo);

      const ledger = readLedger(paths.ledger);
      const sessionRow = ledger.sessions.find((s) => s.session_id === sessionId);
      if (!sessionRow) throw new Error("test setup invariant: no session row found after ingest");
      const footprintPaths = ledger.footprint.filter((f) => f.session_id === sessionId).map((f) => f.path);
      expect(
        footprintPaths.length,
        "test setup invariant: expected at least one footprint path for the headless session (note.txt via Write/Edit)",
      ).toBeGreaterThan(0);

      const showResult = await runCli(["show", sessionId], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(showResult.exitCode, `show did not exit 0; stderr: ${showResult.stderr}`).toBe(0);
      const output = `${showResult.stdout}\n${showResult.stderr}`;

      // --- Header: shas and footprint. ---
      expect(sessionRow.sha_before, "test setup invariant: expected sha_before to be captured (real git repo)").not.toBeNull();
      expect(
        output,
        `show's header did not print sha_before (${sessionRow.sha_before}, read from the ledger's session row)`,
      ).toContain(String(sessionRow.sha_before));
      if (sessionRow.sha_after !== null) {
        expect(
          output,
          `show's header did not print sha_after (${sessionRow.sha_after}, read from the ledger's session row)`,
        ).toContain(String(sessionRow.sha_after));
      }
      for (const path of footprintPaths) {
        expect(output, `show's header did not print the footprint path ${path}`).toContain(path);
      }

      // --- Timeline: lifecycle events. ---
      expect(output, "the timeline did not render the SessionStart lifecycle event").toMatch(/SessionStart/);
      expect(output, "the timeline did not render the SessionEnd lifecycle event").toMatch(/SessionEnd/);
      expect(output, "the timeline did not render a Stop lifecycle event").toMatch(/Stop/);

      // --- Timeline: prompts (UserPromptSubmit). ---
      expect(
        output,
        "the timeline did not render the session's prompt text (UserPromptSubmit)",
      ).toContain("Do these steps in order");

      // --- Timeline: every command with its command string, outcome and
      // duration. "165" (duration_ms) cannot appear in the prompt text, so
      // requiring both together unambiguously selects the real event line.
      findLineWithAll(output, ["echo capture-ok", "165"]);

      // --- Timeline: subagent events, carrying agent_id and agent_type. ---
      findLineWithAll(output, ["ad8e71db58d6e5943", "general-purpose"]);

      // --- Unknown session id exits nonzero, naming the id. ---
      const unknownSessionId = "00000000-0000-0000-0000-000000000000";
      const unknownResult = await runCli(["show", unknownSessionId], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(
        unknownResult.exitCode,
        "show with an unknown session id exited 0 (expected nonzero)",
      ).not.toBe(0);
      const unknownOutput = `${unknownResult.stdout}\n${unknownResult.stderr}`;
      expect(
        unknownOutput,
        "show with an unknown session id did not name the id in its error output",
      ).toContain(unknownSessionId);
    },
    60000,
  );

  it(
    "R8 Facets. Per session: sha before/after from boundary lines; footprint = distinct file paths from file-editing tool events; every Bash command records its command string, outcome, and duration; a PostToolUseFailure records a failure outcome with its error string preserved; an auto-backgrounded command records outcome ABSENT, distinguishable from both success and failure.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(initResult.exitCode, `test setup invariant: init did not exit 0; stderr: ${initResult.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];
      const headlessLines = loadFixtureStream("headless");
      await replayFixtures("headless", command);
      const sessionId = sessionIdOf(headlessLines[0]!);

      await ingestViaLog(repo);

      const showResult = await runCli(["show", sessionId], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(showResult.exitCode, `show did not exit 0; stderr: ${showResult.stderr}`).toBe(0);
      const output = `${showResult.stdout}\n${showResult.stderr}`;

      // success: PostToolUse on a Bash command, no failure marker. Fixture:
      // "echo capture-ok", duration_ms 165, tool_response with no error.
      // "165" cannot appear in the prompt text, so this unambiguously
      // selects the real event line.
      const successLine = findLineWithAll(output, ["echo capture-ok", "165"]);
      expect(
        successLine,
        `the successful Bash command's line rendered the ABSENT marker (${ABSENT_MARKER}) instead of a success outcome`,
      ).not.toContain(ABSENT_MARKER);
      expect(
        successLine,
        "the successful Bash command's line rendered a failure error string it should not carry",
      ).not.toMatch(/Exit code/);

      // failure: PostToolUseFailure, whose error string is preserved
      // verbatim (embeds "Exit code N" plus the message). Fixture:
      // "cat /nonexistent-file-for-recording", duration_ms 19, error "Exit
      // code 1\n...No such file or directory (os error 2)". Neither "Exit
      // code 1" nor the OS error message appear in the prompt text.
      const failureLine = findLineWithAll(output, [
        "cat /nonexistent-file-for-recording",
        "Exit code 1",
        "No such file or directory",
      ]);
      expect(failureLine, "the failed command's line did not carry its duration (19ms)").toContain("19");
      expect(
        failureLine,
        `the failed command's line rendered the ABSENT marker (${ABSENT_MARKER}) instead of a failure outcome`,
      ).not.toContain(ABSENT_MARKER);

      // ABSENT: an auto-backgrounded command — PostToolUse whose
      // tool_response carries a backgroundTaskId with no exit outcome.
      // Fixture: "sleep 90", tool_response.backgroundTaskId "bzc1n4ebp".
      const absentLine = findLineWithAll(output, ["sleep 90", ABSENT_MARKER]);
      expect(
        absentLine,
        "the auto-backgrounded command's line rendered a failure error string (must be ABSENT, not failure)",
      ).not.toMatch(/Exit code/);

      // footprint: distinct file paths from file-editing tool events
      // (Write then Edit, both on note.txt — must dedupe to one path).
      const ledger = readLedger(paths.ledger);
      const footprintRows = ledger.footprint.filter((f) => f.session_id === sessionId);
      expect(
        footprintRows.map((f) => f.path),
        "test setup invariant: expected exactly the note.txt path in the footprint table",
      ).toEqual(expect.arrayContaining([expect.stringContaining("note.txt")]));
      for (const row of footprintRows) {
        expect(output, `show's header did not print the footprint path ${row.path}`).toContain(row.path);
      }

      // sha before/after from boundary lines: independent oracle is the
      // ledger row itself (already-shipped, independently-tested ingest
      // machinery — never re-derived here).
      const sessionRow = ledger.sessions.find((s) => s.session_id === sessionId);
      if (!sessionRow) throw new Error("test setup invariant: no session row found after ingest");
      expect(sessionRow.sha_before, "test setup invariant: expected sha_before to be captured").not.toBeNull();
      expect(output, "show's header did not print sha_before").toContain(String(sessionRow.sha_before));
    },
    60000,
  );

  it(
    "R12 Degradation rendering. In log and show, an absent facet renders as an explicit absent marker, distinguishable from empty/zero/success - asserted for sha-absent (the SIGKILL stream has no SessionEnd) and outcome-absent (a backgrounded command). Session kind is NOT an absent case (the recording pass found the model-key signal): assert instead that the interactive fixture renders kind interactive and a headless fixture renders kind headless, and exercise the kind-absent drift fallback (a session with no SessionStart line) separately.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(initResult.exitCode, `test setup invariant: init did not exit 0; stderr: ${initResult.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];

      // --- sha-absent (show): the SIGKILL stream has no SessionEnd line, so
      // sha_after must stay NULL in the ledger and render as ABSENT here. ---
      const sigkillLines = loadFixtureStream("SIGKILL");
      await replayFixtures("SIGKILL", command);
      const sigkillSessionId = sessionIdOf(sigkillLines[0]!);

      // --- outcome-absent (show): the headless fixture's own
      // auto-backgrounded "sleep 90" command, in the SAME repo/ledger. ---
      const headlessLines = loadFixtureStream("headless");
      await replayFixtures("headless", command);
      const headlessSessionId = sessionIdOf(headlessLines[0]!);

      // --- kind (log): interactive fixture renders "interactive", headless
      // fixture renders "headless" — neither is an absent case. ---
      const interactiveLines = loadFixtureStream("interactive");
      await replayFixtures("interactive", command);
      const interactiveSessionId = sessionIdOf(interactiveLines[0]!);

      // --- kind-absent drift fallback (log): a session with no captured
      // SessionStart line (built from the SIGKILL stream's non-boundary
      // lines, mirroring ISS-0007's own technique). ---
      const missingStartSessionId = "iss8-r12-missing-start-session";
      const skippedStartLines = loadFixtureStream("SIGKILL").slice(1);
      for (const line of skippedStartLines) {
        const payload = { ...JSON.parse(line), session_id: missingStartSessionId };
        const invocation = await runRawHookInvocation(command, JSON.stringify(payload));
        expect(invocation.exitCode, "a hook invocation for the missing-SessionStart session did not exit 0").toBe(0);
      }

      // Ingest everything replayed so far (show reads the ledger, not the
      // spool) before reading it back as an oracle.
      await ingestViaLog(repo);

      const ledger = readLedger(paths.ledger);
      const sigkillRow = ledger.sessions.find((s) => s.session_id === sigkillSessionId);
      if (!sigkillRow) throw new Error("test setup invariant: no session row found for the SIGKILL session");
      expect(
        sigkillRow.sha_after,
        "test setup invariant: sha_after must be NULL for a session with no SessionEnd",
      ).toBeNull();

      // --- show: sha-absent. ---
      const sigkillShowResult = await runCli(["show", sigkillSessionId], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(sigkillShowResult.exitCode, `show did not exit 0; stderr: ${sigkillShowResult.stderr}`).toBe(0);
      const sigkillOutput = `${sigkillShowResult.stdout}\n${sigkillShowResult.stderr}`;
      expect(
        sigkillOutput,
        `show's header did not render the ABSENT marker (${ABSENT_MARKER}) for sha_after when no SessionEnd was captured`,
      ).toContain(ABSENT_MARKER);

      // --- show: outcome-absent. ---
      const headlessShowResult = await runCli(["show", headlessSessionId], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(headlessShowResult.exitCode, `show did not exit 0; stderr: ${headlessShowResult.stderr}`).toBe(0);
      const headlessOutput = `${headlessShowResult.stdout}\n${headlessShowResult.stderr}`;
      findLineWithAll(headlessOutput, ["sleep 90", ABSENT_MARKER]);

      // --- log: kind interactive/headless (not absent) and the kind-absent
      // drift fallback. ---
      const logResult = await runCli(["log"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(logResult.exitCode, `log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);
      const logOutput = `${logResult.stdout}\n${logResult.stderr}`;

      const headlessLogLine = findSessionLine(logOutput, headlessSessionId);
      expect(
        headlessLogLine,
        "the headless fixture's session line did not render kind as headless",
      ).toContain("headless");

      const interactiveLogLine = findSessionLine(logOutput, interactiveSessionId);
      expect(
        interactiveLogLine,
        "the interactive fixture's session line did not render kind as interactive",
      ).toContain("interactive");

      const missingStartLine = findSessionLine(logOutput, missingStartSessionId);
      expect(
        missingStartLine,
        `the session with no captured SessionStart line did not render the ABSENT marker (${ABSENT_MARKER}) for kind`,
      ).toContain(ABSENT_MARKER);
      expect(
        missingStartLine,
        "the session with no captured SessionStart line guessed kind as headless instead of ABSENT",
      ).not.toMatch(/headless/);
      expect(
        missingStartLine,
        "the session with no captured SessionStart line guessed kind as interactive instead of ABSENT",
      ).not.toMatch(/interactive/);
    },
    60000,
  );
});
