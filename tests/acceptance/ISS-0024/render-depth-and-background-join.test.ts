// ISS-0024 acceptance tests — Render depth (R12) + the backgrounded-outcome
// join (R14) (docs/issues/ISS-0024.md).
//
// Test-harness contract: reuses the acceptance harness's primitives verbatim
// from ../harness/index.js (tmpdir-repo factory, CLI runner, replayLines,
// readLedger) plus the fixtures layer's already-shipped typed access
// (../../fixtures/loader.js's loadFixtureStream) and the transcript-
// substituting replay wrapper (../../fixtures/transcriptReplay.js's
// buildSubstitutedTranscript) for cost-present sessions. The harness's own
// replayLines pins cwd/transcript_path by construction (ISS-0033); a
// substituted transcript's own path survives via transcriptPathOverride.
//
// No module this issue touches (src/render/log.ts, src/render/show.ts,
// src/facets/outcome.ts, src/ingest/**) is imported directly — every
// assertion below drives the built CLI as a subprocess (runCli) and reads
// either its stdout (the render seam) or the ledger's already-shipped
// `events` rows (src/core/ledger.ts's EventRow, whose nullable
// `background_task_id` column already exists — this issue only populates
// it). src/render/absent.ts's ABSENT_MARKER is an already-shipped, unrelated
// constant this issue reuses rather than redefines, so it is imported
// statically as an independent oracle for the exact absent token.
//
// The background scenario's expected join facts (task id, exit code) are
// pinned in tests/fixtures/transcripts/manifest.json's "background" pair
// probe metadata — read directly here (the typed loader's TranscriptPair
// does not surface `probe`), never re-derived by hand-parsing the stream.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpRepo, runCli, replayLines, readLedger, type ReplayOptions, type TmpRepo } from "../harness/index.js";
import { loadFixtureStream } from "../../fixtures/loader.js";
import { buildSubstitutedTranscript } from "../../fixtures/transcriptReplay.js";
import { getPaths } from "../../../src/core/paths.js";
import { ABSENT_MARKER } from "../../../src/render/absent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const TRANSCRIPTS_MANIFEST_PATH = join(REPO_ROOT, "tests/fixtures/transcripts/manifest.json");

interface BackgroundProbe {
  background_task_id: string;
  resolved_by: string;
  exitCode: number;
}

// The pinned join facts for the "background" scenario, read directly from
// the transcripts manifest (the typed loader does not surface `probe`) —
// never re-derived by grepping the fixture stream by hand.
function readBackgroundProbe(): BackgroundProbe {
  const raw = JSON.parse(readFileSync(TRANSCRIPTS_MANIFEST_PATH, "utf8")) as {
    pairs: Array<{ scenario: string; probe?: BackgroundProbe }>;
  };
  const pair = raw.pairs.find((p) => p.scenario === "background");
  if (!pair?.probe) throw new Error("test setup invariant: the background pair must carry probe metadata");
  return pair.probe;
}

// Seeding invariant carried by the pre-ISS-0033 replayLinesThroughHook
// helper: capture exits 0 for every replayed line.
async function replayExpectingExit0(lines: string[], pinTarget: string, options?: ReplayOptions): Promise<void> {
  for (const invocation of await replayLines(lines, pinTarget, options)) {
    expect(invocation.exitCode, "a hook invocation of a replayed fixture line did not exit 0").toBe(0);
  }
}

function sessionIdOf(fixtureLine: string): string {
  const parsed = JSON.parse(fixtureLine) as { session_id?: unknown };
  if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) {
    throw new Error("test setup invariant: fixture line has no session_id");
  }
  return parsed.session_id;
}

// Mirrors src/render/log.ts's own shortId (existing, PRD-0001-pinned
// behavior this issue's invariants require to stay untouched) — used only
// to locate a session's own rendered line among several, never to assert
// its format.
function shortIdOf(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function withSessionId(templateLine: string, sessionId: string): string {
  const parsed = JSON.parse(templateLine) as Record<string, unknown>;
  parsed.session_id = sessionId;
  return JSON.stringify(parsed);
}

// Clones a recorded PostToolUse line, swapping only session/tool-use
// identity, the Bash command string and the captured stdout text — mirrors
// ISS-0018's own buildSyntheticPostToolUse, needed to reach the
// claimed-zero-tests branch no recorded fixture line exercises on its own.
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

async function ingestViaLog(repo: TmpRepo): Promise<void> {
  const result = await runCli(["log"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
  expect(result.exitCode, `test setup invariant: log (ingest) did not exit 0; stderr: ${result.stderr}`).toBe(0);
}

// Finds a rendered line containing ALL of `tokens` together — mirrors
// ISS-0007/ISS-0008/ISS-0018/ISS-0019's own findLineWithAll.
function findLineWithAll(output: string, tokens: string[]): string {
  const matches = output.split("\n").filter((line) => tokens.every((t) => line.includes(t)));
  expect(
    matches.length,
    `expected at least one rendered line containing all of ${JSON.stringify(tokens)}, found none. Full output:\n${output}`,
  ).toBeGreaterThanOrEqual(1);
  return matches[0]!;
}

describe("ISS-0024 render depth (R12) + the backgrounded-outcome join (R14)", () => {
  const tmpRepos: TmpRepo[] = [];
  const scratchDirs: string[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeScratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  it(
    "R12 Render. log gains derived-marked cost and a checks column; show heads the timeline with cost (derived marker) and renders checks and test results as badge lines. Absent renders with the explicit absent marker, asserted for cost-absent and test-results-absent (the R12/PRD-0001 pattern extended).",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };
      const init = await runCli(["init"], opts);
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);

      // --- Session A: cost present (substituted transcript) + two explicit checks bound. ---
      const workDir = makeScratchDir("coreartifact-iss24-r12-cost-");
      const substituted = buildSubstitutedTranscript("cost-headless", workDir);
      const costSessionId = sessionIdOf(loadFixtureStream("cost-headless")[0]!);
      await replayExpectingExit0(substituted.lines, repo.root, { transcriptPathOverride: substituted.transcriptPath });
      await runCli(
        ["check", "riss24-r12-pass", "--session", costSessionId, "--", "node", "-e", "process.exit(0)"],
        opts,
      );
      await runCli(
        ["check", "riss24-r12-fail", "--session", costSessionId, "--", "node", "-e", "process.exit(1)"],
        opts,
      );

      // --- Session B: cost absent (guaranteed-nonexistent transcript path), no checks, no vitest run. ---
      const missingTranscriptPath = join(
        makeScratchDir("coreartifact-iss24-r12-missing-"),
        "nonexistent.transcript.jsonl",
      );
      const absentSessionId = sessionIdOf(loadFixtureStream("headless")[0]!);
      await replayExpectingExit0(loadFixtureStream("headless"), repo.root, { transcriptPathOverride: missingTranscriptPath });

      await ingestViaLog(repo);

      // --- log: checks column (pass and fail visible) + derived cost marker for session A. ---
      const logResult = await runCli(["log"], opts);
      expect(logResult.exitCode, `log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);
      const logOutput = `${logResult.stdout}\n${logResult.stderr}`;
      const costLogLine = findLineWithAll(logOutput, [shortIdOf(costSessionId)]);
      expect(
        costLogLine,
        "log's session line for the cost-bearing session must show a derived-marked cost",
      ).toMatch(/derived/i);
      expect(
        costLogLine.toLowerCase(),
        "log's checks column must make a passing bound check visible",
      ).toMatch(/pass/);
      expect(
        costLogLine.toLowerCase(),
        "log's checks column must make a failing bound check visible",
      ).toMatch(/fail/);

      // --- log: cost-absent session renders the explicit absent marker, never zero or blank. ---
      const absentLogLine = findLineWithAll(logOutput, [shortIdOf(absentSessionId)]);
      expect(
        absentLogLine,
        "a session with no transcript-derived cost must render the explicit absent marker",
      ).toContain(ABSENT_MARKER);
      expect(absentLogLine, "cost-absent must never render as a bare zero").not.toMatch(/cost:\s*0(\D|$)/);

      // --- show: cost heads the timeline (derived marker before the first timeline entry) + check badges. ---
      const showResult = await runCli(["show", costSessionId], opts);
      expect(showResult.exitCode, `show did not exit 0; stderr: ${showResult.stderr}`).toBe(0);
      const showLines = showResult.stdout.split("\n");
      const costLineIndex = showLines.findIndex((l) => /derived/i.test(l));
      const firstTimelineIndex = showLines.findIndex((l) => /\[\d+\]/.test(l));
      expect(costLineIndex, "show must render a derived-marked cost line").toBeGreaterThanOrEqual(0);
      expect(firstTimelineIndex, "show must render a timeline").toBeGreaterThanOrEqual(0);
      expect(
        costLineIndex,
        "the cost line must head the timeline, appearing before the first timeline entry",
      ).toBeLessThan(firstTimelineIndex);

      const passBadge = findLineWithAll(showResult.stdout, ["riss24-r12-pass"]);
      expect(passBadge.toLowerCase(), "the passing check's badge line must name pass").toMatch(/pass/);
      const failBadge = findLineWithAll(showResult.stdout, ["riss24-r12-fail"]);
      expect(failBadge.toLowerCase(), "the failing check's badge line must name fail").toMatch(/fail/);

      // --- show: test-results-absent — no fabricated test-results badge for a session with no vitest run. ---
      const showAbsent = await runCli(["show", absentSessionId], opts);
      expect(showAbsent.exitCode, `show did not exit 0; stderr: ${showAbsent.stderr}`).toBe(0);
      expect(
        showAbsent.stdout,
        "a session with no test-results facet must not fabricate a test-results badge",
      ).not.toMatch(/\d+ passed, \d+ failed/);
    },
    60000,
  );

  it(
    "R14 Backgrounded outcome join. Ingest resolves a backgrounded command's outcome by joining the backgrounding event's backgroundTaskId to later TaskOutput events in the same session and reading the matched task's exit code. Replaying background.jsonl yields the backgrounded command's outcome resolved (exit 0); replaying it truncated before the completed poll yields outcome ABSENT — no poll, no join, no guess.",
    async () => {
      const probe = readBackgroundProbe();
      expect(probe.exitCode, "test setup invariant: the pinned probe must name exit code 0").toBe(0);

      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };
      const init = await runCli(["init"], opts);
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);

      const backgroundLines = loadFixtureStream("background");
      const sessionId = sessionIdOf(backgroundLines[0]!);
      await replayExpectingExit0(backgroundLines, repo.root);
      await ingestViaLog(repo);

      // --- ingest promotes background_task_id onto both the backgrounding event and the completed TaskOutput event. ---
      const events = readLedger(paths.ledger).events.filter((e) => e.session_id === sessionId);
      const backgroundingEvent = events.find((e) => {
        if (e.hook_event_name !== "PostToolUse") return false;
        const payload = JSON.parse(e.payload) as { tool_response?: { backgroundTaskId?: unknown } };
        return payload.tool_response?.backgroundTaskId === probe.background_task_id;
      });
      expect(
        backgroundingEvent,
        "no PostToolUse event carried the backgrounding tool_response.backgroundTaskId",
      ).toBeDefined();
      expect(
        backgroundingEvent!.background_task_id,
        "the backgrounding event's background_task_id column was not promoted from tool_response.backgroundTaskId",
      ).toBe(probe.background_task_id);

      const completedTaskOutputEvent = events.find((e) => {
        if (e.hook_event_name !== "PostToolUse") return false;
        const payload = JSON.parse(e.payload) as { tool_response?: { task?: { exitCode?: unknown } } };
        return payload.tool_response?.task?.exitCode === probe.exitCode;
      });
      expect(
        completedTaskOutputEvent,
        "no PostToolUse(TaskOutput) event carried the completed poll's exitCode",
      ).toBeDefined();
      expect(
        completedTaskOutputEvent!.background_task_id,
        "the completed TaskOutput event's background_task_id column was not promoted from tool_input.task_id",
      ).toBe(probe.background_task_id);

      // --- the outcome resolves at show time: success, joined via background_task_id, never ABSENT-final. ---
      const showResult = await runCli(["show", sessionId], opts);
      expect(showResult.exitCode, `show did not exit 0; stderr: ${showResult.stderr}`).toBe(0);
      const backgroundedLine = findLineWithAll(showResult.stdout, ["command:", "./probe.sh"]);
      expect(
        backgroundedLine,
        "a backgrounded command whose TaskOutput poll resolved with exit code 0 must render outcome success, not the old v1 ABSENT-final",
      ).toMatch(/success/);
    },
    30000,
  );

  it(
    "log renders one checks column summarizing each session's bound checks with pass and fail visible, and a derived-marked cost column; a session with no transcript-derived cost renders the explicit absent marker in the cost column, never a zero or a blank.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };
      const init = await runCli(["init"], opts);
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);

      const workDir = makeScratchDir("coreartifact-iss24-log-cost-");
      const substituted = buildSubstitutedTranscript("cost-headless", workDir);
      const costSessionId = sessionIdOf(loadFixtureStream("cost-headless")[0]!);
      await replayExpectingExit0(substituted.lines, repo.root, { transcriptPathOverride: substituted.transcriptPath });
      await runCli(
        ["check", "riss24-log-pass", "--session", costSessionId, "--", "node", "-e", "process.exit(0)"],
        opts,
      );
      await runCli(
        ["check", "riss24-log-fail", "--session", costSessionId, "--", "node", "-e", "process.exit(1)"],
        opts,
      );

      const missingTranscriptPath = join(
        makeScratchDir("coreartifact-iss24-log-missing-"),
        "nonexistent.transcript.jsonl",
      );
      const absentSessionId = sessionIdOf(loadFixtureStream("headless")[0]!);
      await replayExpectingExit0(loadFixtureStream("headless"), repo.root, { transcriptPathOverride: missingTranscriptPath });

      await ingestViaLog(repo);

      const logResult = await runCli(["log"], opts);
      expect(logResult.exitCode, `log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);

      const costLine = findLineWithAll(logResult.stdout, [shortIdOf(costSessionId)]);
      expect(
        costLine,
        "log's cost column must render a derived marker for a session with a real transcript-derived cost",
      ).toMatch(/derived/i);
      expect(
        costLine.toLowerCase(),
        "log's checks column must make the passing bound check visible",
      ).toMatch(/pass/);
      expect(
        costLine.toLowerCase(),
        "log's checks column must make the failing bound check visible",
      ).toMatch(/fail/);

      const absentLine = findLineWithAll(logResult.stdout, [shortIdOf(absentSessionId)]);
      expect(
        absentLine,
        "a session with no transcript-derived cost must render the explicit absent marker in the cost column",
      ).toContain(ABSENT_MARKER);
      expect(absentLine, "cost-absent must never render as a bare zero").not.toMatch(/cost:\s*0(\D|$)/);
    },
    60000,
  );

  it(
    "show heads the timeline with the derived-marked cost line and renders each bound check and each test-results facet as a badge line naming pass or fail; a session with no test-results facet renders the explicit absent marker for test results, distinguishable from a claimed run reporting zero tests.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };
      const init = await runCli(["init"], opts);
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);

      // --- Session A: real cost + real test-results facet + two bound checks. ---
      const workDir = makeScratchDir("coreartifact-iss24-show-vitest-");
      const substituted = buildSubstitutedTranscript("vitest", workDir);
      const vitestSessionId = sessionIdOf(loadFixtureStream("vitest")[0]!);
      await replayExpectingExit0(substituted.lines, repo.root, { transcriptPathOverride: substituted.transcriptPath });
      await runCli(
        ["check", "riss24-show-pass", "--session", vitestSessionId, "--", "node", "-e", "process.exit(0)"],
        opts,
      );
      await runCli(
        ["check", "riss24-show-fail", "--session", vitestSessionId, "--", "node", "-e", "process.exit(1)"],
        opts,
      );

      // --- Session B: a claimed vitest run reporting zero tests (synthetic, mirrors ISS-0018's own synthetic row). ---
      const vitestLines = loadFixtureStream("vitest");
      const zeroTestsSessionId = "iss24-r12-zero-tests-session";
      const startLine = withSessionId(vitestLines[0]!, zeroTestsSessionId);
      const zeroTestsLine = buildSyntheticPostToolUse(vitestLines[3]!, {
        sessionId: zeroTestsSessionId,
        toolUseId: "toolu-iss24-zero-tests",
        command: "pnpm vitest run zero.test.js",
        stdout:
          " Test Files  1 passed (1)\n      Tests  0 passed (0)\n   Duration  9ms (transform 1ms, setup 0ms, import 1ms, tests 0ms, environment 0ms)",
      });
      const endLine = withSessionId(vitestLines[7]!, zeroTestsSessionId);
      await replayExpectingExit0([startLine, zeroTestsLine, endLine], repo.root);

      // --- Session C: no test-results facet whatsoever (headless: no vitest command anywhere in the stream). ---
      const headlessSessionId = sessionIdOf(loadFixtureStream("headless")[0]!);
      await replayExpectingExit0(loadFixtureStream("headless"), repo.root);

      await ingestViaLog(repo);

      // --- show heads the timeline with the derived-marked cost line, and renders check + test-results badges. ---
      const showA = await runCli(["show", vitestSessionId], opts);
      expect(showA.exitCode, `show did not exit 0; stderr: ${showA.stderr}`).toBe(0);
      const linesA = showA.stdout.split("\n");
      const costLineIndex = linesA.findIndex((l) => /derived/i.test(l));
      const firstTimelineIndex = linesA.findIndex((l) => /\[\d+\]/.test(l));
      expect(costLineIndex, "show must render a derived-marked cost line").toBeGreaterThanOrEqual(0);
      expect(firstTimelineIndex, "show must render a timeline").toBeGreaterThanOrEqual(0);
      expect(costLineIndex, "the cost line must head the timeline").toBeLessThan(firstTimelineIndex);

      const passBadge = findLineWithAll(showA.stdout, ["riss24-show-pass"]);
      expect(passBadge.toLowerCase(), "a passing bound check's badge must name pass").toMatch(/pass/);
      const failBadge = findLineWithAll(showA.stdout, ["riss24-show-fail"]);
      expect(failBadge.toLowerCase(), "a failing bound check's badge must name fail").toMatch(/fail/);

      const realTestBadge = findLineWithAll(showA.stdout, ["command:", "pnpm vitest run passing.test.js"]);
      expect(
        realTestBadge,
        "a real test-results facet must render a badge naming pass/fail counts",
      ).toMatch(/passed/i);

      // --- Session B: a claimed zero-tests run renders its real zeros, never the absent marker. ---
      const showB = await runCli(["show", zeroTestsSessionId], opts);
      expect(showB.exitCode, `show did not exit 0; stderr: ${showB.stderr}`).toBe(0);
      const zeroBadge = findLineWithAll(showB.stdout, ["command:", "pnpm vitest run zero.test.js"]);
      expect(zeroBadge, "a claimed run reporting zero tests must render its real zero counts").toMatch(
        /0 passed, 0 failed/,
      );
      expect(
        zeroBadge,
        "a claimed zero-tests run must never render the absent marker in place of its real zeros",
      ).not.toContain(ABSENT_MARKER);

      // --- Session C: a session with no test-results facet at all never fabricates a test-results badge. ---
      const showC = await runCli(["show", headlessSessionId], opts);
      expect(showC.exitCode, `show did not exit 0; stderr: ${showC.stderr}`).toBe(0);
      expect(
        showC.stdout,
        "a session with no test-results facet must not render a fabricated pass/fail test-results badge",
      ).not.toMatch(/\d+ passed, \d+ failed/);
    },
    60000,
  );

  it(
    "Replaying the background fixture stream renders the backgrounded command's outcome as success through the TaskOutput join; replaying the same stream truncated before the completed TaskOutput poll renders outcome with the explicit absent marker — never success, never failure.",
    async () => {
      const backgroundLines = loadFixtureStream("background");

      // --- Full replay: the completed TaskOutput poll (exitCode 0) is present. ---
      const repoFull = await createTmpRepo();
      tmpRepos.push(repoFull);
      const optsFull = { cwd: repoFull.root, home: repoFull.home, registryPath: repoFull.registryPath };
      const initFull = await runCli(["init"], optsFull);
      expect(initFull.exitCode, `test setup invariant: init did not exit 0; stderr: ${initFull.stderr}`).toBe(0);

      const fullSessionId = sessionIdOf(backgroundLines[0]!);
      await replayExpectingExit0(backgroundLines, repoFull.root);
      await ingestViaLog(repoFull);

      const showFull = await runCli(["show", fullSessionId], optsFull);
      expect(showFull.exitCode, `show did not exit 0; stderr: ${showFull.stderr}`).toBe(0);
      const fullLine = findLineWithAll(showFull.stdout, ["command:", "./probe.sh"]);
      expect(
        fullLine,
        "a fully-replayed background stream must resolve the backgrounded command's outcome to success",
      ).toMatch(/success/);
      expect(fullLine, "a resolved backgrounded outcome must never render as a failure").not.toMatch(/failure/);
      expect(
        fullLine,
        "a resolved backgrounded outcome must never render as the absent marker",
      ).not.toContain(ABSENT_MARKER);

      // --- Truncated replay: cut off before the completed TaskOutput poll (the recorded stream's line 12 —
      // the PostToolUse carrying retrieval_status "success"/exitCode 0). Only the in-flight poll (line 10,
      // exitCode null, status "running") is present before the cut; no completed match exists. Derived here
      // in memory from the loaded stream — nothing hand-authored is committed. ---
      const truncatedLines = backgroundLines.slice(0, 11);
      expect(
        truncatedLines.some((line) => {
          const parsed = JSON.parse(line) as { tool_response?: { task?: { exitCode?: unknown } } };
          return parsed.tool_response?.task?.exitCode === 0;
        }),
        "test setup invariant: the truncated prefix must not itself contain a completed (exitCode 0) TaskOutput poll",
      ).toBe(false);

      const repoTruncated = await createTmpRepo();
      tmpRepos.push(repoTruncated);
      const optsTruncated = {
        cwd: repoTruncated.root,
        home: repoTruncated.home,
        registryPath: repoTruncated.registryPath,
      };
      const initTruncated = await runCli(["init"], optsTruncated);
      expect(
        initTruncated.exitCode,
        `test setup invariant: init did not exit 0; stderr: ${initTruncated.stderr}`,
      ).toBe(0);

      await replayExpectingExit0(truncatedLines, repoTruncated.root);
      await ingestViaLog(repoTruncated);

      const showTruncated = await runCli(["show", fullSessionId], optsTruncated);
      expect(showTruncated.exitCode, `show did not exit 0; stderr: ${showTruncated.stderr}`).toBe(0);
      const truncatedLine = findLineWithAll(showTruncated.stdout, ["command:", "./probe.sh"]);
      expect(
        truncatedLine,
        "no completed TaskOutput poll before session end must render outcome as the explicit absent marker",
      ).toContain(ABSENT_MARKER);
      expect(truncatedLine, "an unresolved backgrounded outcome must never render as success").not.toMatch(
        /success/,
      );
      expect(truncatedLine, "an unresolved backgrounded outcome must never render as a failure").not.toMatch(
        /failure/,
      );
    },
    30000,
  );
});
