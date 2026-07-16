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
});
