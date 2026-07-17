// ISS-0028 unit tests for src/dashboard/classify.ts -- the pure
// classification and window math (no I/O) the issue packet's Test-harness
// contract calls out as its own seam: "the three-way partition, the window
// boundary (inclusive vs excluded), and the semver drift comparison."
//
// Footprint note: the packet names this file's canonical location as
// tests/unit/dashboard-classify.test.ts, but this agent's write-guard
// permits only tests/acceptance/ISS-0028/**, so it lives here instead,
// alongside overview.test.ts. Not mapped to a numbered acceptance
// criterion (all nine given criteria describe GET /api/overview's HTTP
// behavior); this file is the issue spec's own separately-named unit-test
// requirement.
//
// classify.ts does not exist yet, so it is never imported at module scope
// (a top-level import of a missing module would fail the whole file at
// collection). Loaded instead through a caught dynamic import, mirroring
// tests/acceptance/ISS-0011/attribution.test.ts's own established pattern
// in this codebase.
import { describe, test, expect } from "vitest";
import { TESTED_CLAUDE_CODE_RANGE } from "../../../src/doctor/version.js";

const MODULE_PATH = "../../../src/dashboard/classify";

async function loadClassifyModule() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

function requireExport<T>(mod: any, name: string): T {
  if (!mod) throw new Error("src/dashboard/classify module not implemented yet");
  const value = mod[name];
  if (typeof value !== "function") {
    throw new Error(`src/dashboard/classify does not export ${name} yet`);
  }
  return value as T;
}

describe("ISS-0028 classify.ts: the three-way partition", () => {
  test("a session with zero bound checks classifies as unverified; a session with only passing bound checks classifies as verified; a session with at least one failing bound check classifies as failing even alongside passing checks.", async () => {
    const mod = await loadClassifyModule();
    const classifySessionByChecks = requireExport<(exitCodes: number[]) => string>(mod, "classifySessionByChecks");

    expect(classifySessionByChecks([]), "zero bound checks must classify as unverified").toBe("unverified");
    expect(classifySessionByChecks([0]), "a single passing bound check must classify as verified").toBe("verified");
    expect(classifySessionByChecks([0, 0]), "all-passing bound checks must classify as verified").toBe("verified");
    expect(classifySessionByChecks([1]), "a single failing bound check must classify as failing").toBe("failing");
    expect(
      classifySessionByChecks([0, 1]),
      "at least one failing bound check must classify as failing even when other checks passed",
    ).toBe("failing");
  });
});

describe("ISS-0028 classify.ts: the window boundary (inclusive vs excluded)", () => {
  test("computeWindowBounds derives window.start as exactly OVERVIEW_WINDOW_DAYS before the given end instant, and isSessionInWindow includes a session started exactly at window.start while excluding one started one millisecond earlier.", async () => {
    const mod = await loadClassifyModule();
    const computeWindowBounds = requireExport<(endUtcZ: string, days: number) => { startUtcZ: string; endUtcZ: string }>(
      mod,
      "computeWindowBounds",
    );
    const isSessionInWindow = requireExport<(startedAtUtcZ: string, window: { startUtcZ: string; endUtcZ: string }) => boolean>(
      mod,
      "isSessionInWindow",
    );

    const end = new Date("2026-07-17T12:00:00.000Z");
    const days = 7;
    const bounds = computeWindowBounds(end.toISOString(), days);

    const expectedStart = new Date(end.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    expect(bounds.startUtcZ, "window.start must be exactly OVERVIEW_WINDOW_DAYS before the end instant").toBe(expectedStart);
    expect(bounds.endUtcZ, "window.end must be exactly the given end instant").toBe(end.toISOString());

    expect(
      isSessionInWindow(bounds.startUtcZ, bounds),
      "a session started_at exactly equal to window.start must be INCLUDED (the rolling window is closed at its start boundary)",
    ).toBe(true);

    const oneMsBeforeStart = new Date(new Date(bounds.startUtcZ).getTime() - 1).toISOString();
    expect(
      isSessionInWindow(oneMsBeforeStart, bounds),
      "a session started_at one millisecond before window.start must be EXCLUDED",
    ).toBe(false);

    expect(
      isSessionInWindow(bounds.endUtcZ, bounds),
      "a session started_at exactly equal to window.end (the request instant) must be included",
    ).toBe(true);
  });
});

describe("ISS-0028 classify.ts: the semver drift comparison", () => {
  test("isVersionInRange compares dotted version segments numerically, never lexicographically -- '2.1.9' must not be misread as greater than '2.1.10' by string comparison.", async () => {
    const mod = await loadClassifyModule();
    const isVersionInRange = requireExport<(version: string, range: { min: string; max: string }) => boolean>(
      mod,
      "isVersionInRange",
    );

    // The packet's own canonical trap: '2.1.9' > '2.1.10' under naive
    // string comparison (the '9' byte outranks the leading '1' of '10'),
    // but numerically 9 < 10, so '2.1.9' is BELOW this range's min.
    expect(
      isVersionInRange("2.1.9", { min: "2.1.10", max: "2.1.99" }),
      "'2.1.9' must be recognized as below min '2.1.10' -- a string comparison would wrongly place it above",
    ).toBe(false);

    // The real, currently-pinned TESTED_CLAUDE_CODE_RANGE (reused from
    // src/doctor/version.ts, never re-declared here) -- '2.1.9' is far
    // below its min '2.1.208', which a naive string compare would also get
    // wrong ('9' > '2' at the third segment).
    expect(
      isVersionInRange("2.1.9", TESTED_CLAUDE_CODE_RANGE),
      "'2.1.9' must be recognized as below the real tested range's min '2.1.208'",
    ).toBe(false);

    expect(isVersionInRange(TESTED_CLAUDE_CODE_RANGE.min, TESTED_CLAUDE_CODE_RANGE), "the range's own min must be in-range (inclusive)").toBe(
      true,
    );
    expect(isVersionInRange(TESTED_CLAUDE_CODE_RANGE.max, TESTED_CLAUDE_CODE_RANGE), "the range's own max must be in-range (inclusive)").toBe(
      true,
    );
    expect(isVersionInRange("2.1.220", TESTED_CLAUDE_CODE_RANGE), "a version well above the range's max must be out of range").toBe(false);
  });
});
