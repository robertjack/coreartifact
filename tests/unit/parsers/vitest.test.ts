// Unit tests for the vitest parser (docs/issues/ISS-0018.md "Test-harness
// contract"): passing summary, failing summary with names, zero-tests,
// non-vitest output -> null, duration absent -> null duration. Below the
// seam — pure logic over plain text, no ledger, no CLI subprocess.
//
// The passing and failing summaries are read through the fixtures loader
// (never pasted by hand) since a recorded string exists for both; the
// zero-tests, non-vitest and duration-absent cases have no recorded fixture
// text, so they are hand-authored the way the spec's own R4/criterion-4
// synthetic acceptance cases are.
import { describe, it, expect } from "vitest";
import { parseVitest } from "../../../src/parsers/vitest.js";
import { loadFixtureStream } from "../../fixtures/loader.js";

function payloadAt(lines: string[], index: number): Record<string, unknown> {
  return JSON.parse(lines[index]!) as Record<string, unknown>;
}

const FAILURE_MARKER = "Exit code 1\n\n";

describe("parseVitest", () => {
  it("claims a passing recorded summary and reports counts, no failed names, and a parsed duration", () => {
    const vitestLines = loadFixtureStream("vitest");
    const passing = payloadAt(vitestLines, 3);
    const stdout = (passing.tool_response as { stdout: string }).stdout;

    const result = parseVitest("pnpm vitest run passing.test.js", stdout, "", 0);

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(2);
    expect(result!.failed).toBe(0);
    expect(result!.skipped).toBe(0);
    expect(result!.failedNames).toEqual([]);
    expect(result!.durationMs).toBe(65);
  });

  it("claims a failing recorded summary (parsed from the error string after the Exit code 1 marker) with failed names extracted", () => {
    const vitestLines = loadFixtureStream("vitest");
    const failing = payloadAt(vitestLines, 5);
    const error = failing.error as string;
    expect(error.startsWith(FAILURE_MARKER)).toBe(true);
    const stripped = error.slice(FAILURE_MARKER.length);

    const result = parseVitest("pnpm vitest run", stripped, "", 1);

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(3);
    expect(result!.failed).toBe(1);
    expect(result!.skipped).toBe(0);
    expect(result!.failedNames).toEqual(["subtracts (deliberately red for the fixture)"]);
    expect(result!.durationMs).toBe(74);
  });

  it("a claimed run reporting zero tests stores a real zero, not absence", () => {
    const stdout =
      " Test Files  1 passed (1)\n      Tests  0 passed (0)\n   Duration  12ms (transform 1ms, setup 0ms, import 1ms, tests 0ms, environment 0ms)";
    const result = parseVitest("pnpm vitest run zero.test.js", stdout, "", 0);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(0);
    expect(result!.failed).toBe(0);
    expect(result!.skipped).toBe(0);
    expect(result!.failedNames).toEqual([]);
    expect(result!.durationMs).toBe(12);
  });

  it("returns null for output whose shape has no vitest summary lines (a non-test command)", () => {
    expect(parseVitest("echo capture-ok", "capture-ok", "", 0)).toBeNull();
  });

  it("returns null duration_ms (never 0) when the captured output has no Duration line", () => {
    const stdout = " Test Files  1 passed (1)\n      Tests  2 passed (2)";
    const result = parseVitest("pnpm vitest run duration-unextractable.test.js", stdout, "", 0);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(2);
    expect(result!.durationMs).toBeNull();
  });

  // F-A (fix-mode adversarial review): a failing run's own FAIL-detail
  // output can embed a console-logged line that LOOKS like a vitest summary
  // line (line-start, leading whitespace — exactly what console.log("Tests
  // ...") produces), preceding the REAL trailing summary block further
  // down. The parser must anchor to the TRAILING block (the last "Test
  // Files" line, with its "Tests" line immediately adjacent), never take
  // the first "Tests"-shaped line anywhere in the text — a first-match scan
  // parsed this exact input as {passed:99, failed:0} (a false green) when
  // ground truth was 1 failed.
  it("ignores a console-logged line that looks like a summary line and parses the real trailing summary block instead", () => {
    const stdout = [
      " RUN  v4.1.10 /fake/repo",
      "",
      " ❯ poison.test.js (1 test | 1 failed) 3ms",
      "   × logs a fake summary line 3ms",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      " FAIL  poison.test.js > logs a fake summary line",
      "AssertionError: expected fake summary shape to not fool the parser",
      "",
      "stdout | poison.test.js > logs a fake summary line",
      "     Tests  99 passed (99)",
      "",
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed (1)",
      "   Duration  50ms (transform 1ms, setup 0ms, import 1ms, tests 1ms, environment 0ms)",
    ].join("\n");

    const result = parseVitest("pnpm vitest run poison.test.js", stdout, "", 1);

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(0);
    expect(result!.failed).toBe(1);
    expect(result!.failedNames).toEqual(["logs a fake summary line"]);
    expect(result!.durationMs).toBe(50);
  });

  it("still returns null (never a poison parse) when the trailing block is unparseable", () => {
    const stdout = [
      "     Tests  99 passed (99)",
      "some unrelated tail output that never forms a real summary block",
    ].join("\n");
    expect(parseVitest("pnpm vitest run poison.test.js", stdout, "", 0)).toBeNull();
  });
});
