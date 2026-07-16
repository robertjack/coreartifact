// The vitest parser — the only parser shipped in v1 (docs/issues/ISS-0018.md
// "The interface (design considered twice)"). Claims a command by the SHAPE
// of its captured output (the vitest summary lines), never by grepping the
// command string — a `pnpm test` alias must still parse, and a claimed
// command reporting zero tests is a real zero, not absence.
import type { Parser, TestResults } from "./types.js";

// vitest's own summary block, both scenarios recorded in the vitest fixture:
//  Test Files  1 passed (1)
//       Tests  2 passed (2)
//    Duration  65ms (transform 6ms, ...)
// and, on failure:
//  Test Files  1 failed | 1 passed (2)
//       Tests  1 failed | 3 passed (4)
const TEST_FILES_LINE = /^\s*Test Files\s+/;
const TESTS_LINE = /^\s*Tests\s+(.+)$/;
const START_AT_LINE = /^\s*Start at\s+/;
const DURATION_LINE = /^\s*Duration\s+(\d+(?:\.\d+)?)\s*ms/;
const COUNT_TOKEN = /(\d+)\s+(passed|failed|skipped)/g;
// A failed test's own line, e.g. "   × subtracts (deliberately red for the
// fixture) 3ms" — captured greedily then the trailing " Nms" stripped
// afterward (a non-greedy capture with an optional trailing group would
// match the shortest possible name instead, since the group can match zero
// characters).
const FAILED_NAME_LINE = /^\s*×\s+(.+)$/gm;
const TRAILING_DURATION = /\s+\d+(?:\.\d+)?ms$/;

function parseCounts(testsLineText: string): { passed: number; failed: number; skipped: number } {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const match of testsLineText.matchAll(COUNT_TOKEN)) {
    const value = Number(match[1]);
    const label = match[2] as "passed" | "failed" | "skipped";
    counts[label] = value;
  }
  return counts;
}

function parseFailedNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(FAILED_NAME_LINE)) {
    names.push(match[1]!.trim().replace(TRAILING_DURATION, ""));
  }
  return names;
}

// Finds vitest's own TRAILING summary block: the LAST "Test Files" line in
// the text, with a "Tests" line immediately adjacent (the next physical
// line) — never a first-match scan of loose regexes across the whole text.
// A test's own console-logged output can echo a line that LOOKS like a
// summary line (e.g. `console.log("Tests  99 passed (99)")` inside a FAIL
// detail block) but is never immediately preceded by a "Test Files" line,
// so it cannot be mistaken for the real trailing block. Real vitest output
// puts an optional "Start at  HH:MM:SS" line between Tests and Duration
// (both recorded scenarios in the fixture), so Duration is looked for
// either immediately after Tests or one line further, past an optional
// Start-at line — never scanned for anywhere else in the text.
interface SummaryBlock {
  testsLineText: string;
  durationMs: number | null;
}

function findSummaryBlock(text: string): SummaryBlock | null {
  const lines = text.split(/\r?\n/);

  let testFilesIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (TEST_FILES_LINE.test(lines[i]!)) testFilesIndex = i;
  }
  if (testFilesIndex === -1) return null;

  const testsLine = lines[testFilesIndex + 1];
  const testsMatch = testsLine !== undefined ? TESTS_LINE.exec(testsLine) : null;
  if (!testsMatch) return null;

  let durationIndex = testFilesIndex + 2;
  if (lines[durationIndex] !== undefined && START_AT_LINE.test(lines[durationIndex]!)) durationIndex++;
  const durationLine = lines[durationIndex];
  const durationMatch = durationLine !== undefined ? DURATION_LINE.exec(durationLine) : null;

  return {
    testsLineText: testsMatch[1]!,
    durationMs: durationMatch ? Math.round(Number(durationMatch[1])) : null,
  };
}

export const parseVitest: Parser = (_command, stdout, stderr, _exit) => {
  const text = `${stdout}\n${stderr}`;
  const block = findSummaryBlock(text);
  if (block === null) return null;

  const { passed, failed, skipped } = parseCounts(block.testsLineText);
  const result: TestResults = {
    passed,
    failed,
    skipped,
    failedNames: failed > 0 ? parseFailedNames(text) : [],
    durationMs: block.durationMs,
  };
  return result;
};
