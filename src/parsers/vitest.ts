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
const TEST_FILES_LINE = /^\s*Test Files\s+/m;
const TESTS_LINE = /^\s*Tests\s+(.+)$/m;
const DURATION_LINE = /^\s*Duration\s+(\d+(?:\.\d+)?)\s*ms/m;
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

function parseDuration(text: string): number | null {
  const match = DURATION_LINE.exec(text);
  return match ? Math.round(Number(match[1])) : null;
}

export const parseVitest: Parser = (_command, stdout, stderr, _exit) => {
  const text = `${stdout}\n${stderr}`;
  const testsMatch = TESTS_LINE.exec(text);
  if (!TEST_FILES_LINE.test(text) || !testsMatch) return null;

  const { passed, failed, skipped } = parseCounts(testsMatch[1]!);
  const result: TestResults = {
    passed,
    failed,
    skipped,
    failedNames: failed > 0 ? parseFailedNames(text) : [],
    durationMs: parseDuration(text),
  };
  return result;
};
