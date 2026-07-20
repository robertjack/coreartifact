// ISS-0028 unit tests for src/dashboard/classify.ts — the pure
// classification and window math (no I/O) the issue packet's Test-harness
// contract names as its own seam: "the three-way partition, the window
// boundary (inclusive vs excluded), and the semver drift comparison."
//
// tests/acceptance/ISS-0028/classify.test.ts (test-author's own footprint
// forced it there, see that file's header) already covers this seam's
// headline cases. This file is the packet's own canonical location for it
// and adds the edge cases that file's necessarily narrower footprint left
// uncovered: multiple failing checks, a window with days=0, malformed/short
// version strings, and a version with more segments than the range.
import { describe, test, expect } from "vitest";
import {
  classifySessionByChecks,
  computeWindowBounds,
  isSessionInWindow,
  isVersionInRange,
  OVERVIEW_WINDOW_DAYS,
  LATEST_SESSIONS_LIMIT,
} from "../../src/dashboard/classify.js";
import { TESTED_CLAUDE_CODE_RANGE } from "../../src/doctor/version.js";

describe("classify.ts: named constants", () => {
  test("OVERVIEW_WINDOW_DAYS is the rolling 7-day span and LATEST_SESSIONS_LIMIT is 50", () => {
    expect(OVERVIEW_WINDOW_DAYS).toBe(7);
    expect(LATEST_SESSIONS_LIMIT).toBe(50);
  });
});

describe("classify.ts: classifySessionByChecks", () => {
  test("zero bound checks is unverified", () => {
    expect(classifySessionByChecks([])).toBe("unverified");
  });

  test("all-passing bound checks (one or many) is verified", () => {
    expect(classifySessionByChecks([0])).toBe("verified");
    expect(classifySessionByChecks([0, 0, 0])).toBe("verified");
  });

  test("any failing bound check makes the session failing, regardless of how many checks or their order", () => {
    expect(classifySessionByChecks([1])).toBe("failing");
    expect(classifySessionByChecks([0, 1])).toBe("failing");
    expect(classifySessionByChecks([1, 0])).toBe("failing");
    // Multiple failing checks alongside passing ones: still exactly "failing"
    // (not some fourth state) -- the partition is a flag, not a count.
    expect(classifySessionByChecks([1, 1, 0])).toBe("failing");
    expect(classifySessionByChecks([1, 1])).toBe("failing");
  });

  test("a non-zero exit code is failing regardless of its specific value", () => {
    expect(classifySessionByChecks([2])).toBe("failing");
    expect(classifySessionByChecks([127])).toBe("failing");
    expect(classifySessionByChecks([-1])).toBe("failing");
  });
});

describe("classify.ts: computeWindowBounds / isSessionInWindow", () => {
  test("computeWindowBounds derives a rolling span of exactly `days` before `end`, never a calendar boundary", () => {
    const end = new Date("2026-07-17T12:00:00.000Z");
    const bounds = computeWindowBounds(end.toISOString(), 7);
    expect(bounds.endUtcZ).toBe(end.toISOString());
    expect(bounds.startUtcZ).toBe(new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
  });

  test("days=0 collapses the window to a single instant: only that exact instant is in range", () => {
    const end = new Date("2026-07-17T12:00:00.000Z");
    const bounds = computeWindowBounds(end.toISOString(), 0);
    expect(bounds.startUtcZ).toBe(bounds.endUtcZ);
    expect(isSessionInWindow(bounds.startUtcZ, bounds)).toBe(true);
    expect(isSessionInWindow(new Date(end.getTime() - 1).toISOString(), bounds)).toBe(false);
    expect(isSessionInWindow(new Date(end.getTime() + 1).toISOString(), bounds)).toBe(false);
  });

  test("a session started_at well inside the window is included; well outside on either side is excluded", () => {
    const bounds = computeWindowBounds("2026-07-17T12:00:00.000Z", 7);
    expect(isSessionInWindow("2026-07-14T00:00:00.000Z", bounds)).toBe(true);
    expect(isSessionInWindow("2026-07-01T00:00:00.000Z", bounds)).toBe(false);
    expect(isSessionInWindow("2026-07-20T00:00:00.000Z", bounds)).toBe(false);
  });

  test("both boundaries are inclusive", () => {
    const bounds = computeWindowBounds("2026-07-17T12:00:00.000Z", 7);
    expect(isSessionInWindow(bounds.startUtcZ, bounds)).toBe(true);
    expect(isSessionInWindow(bounds.endUtcZ, bounds)).toBe(true);
    expect(isSessionInWindow(new Date(new Date(bounds.startUtcZ).getTime() - 1).toISOString(), bounds)).toBe(false);
    expect(isSessionInWindow(new Date(new Date(bounds.endUtcZ).getTime() + 1).toISOString(), bounds)).toBe(false);
  });
});

describe("classify.ts: isVersionInRange (numeric, dotted-segment comparison)", () => {
  test("the range's own min and max are in-range (inclusive)", () => {
    expect(isVersionInRange(TESTED_CLAUDE_CODE_RANGE.min, TESTED_CLAUDE_CODE_RANGE)).toBe(true);
    expect(isVersionInRange(TESTED_CLAUDE_CODE_RANGE.max, TESTED_CLAUDE_CODE_RANGE)).toBe(true);
  });

  test("a version strictly below min or above max is out of range", () => {
    expect(isVersionInRange("2.1.207", TESTED_CLAUDE_CODE_RANGE)).toBe(false);
    expect(isVersionInRange("2.1.216", TESTED_CLAUDE_CODE_RANGE)).toBe(false);
  });

  test("comparison is numeric per segment, not lexicographic — '2.1.9' vs '2.1.10'", () => {
    expect(isVersionInRange("2.1.9", { min: "2.1.10", max: "2.1.99" })).toBe(false);
    expect(isVersionInRange("2.1.10", { min: "2.1.9", max: "2.1.99" })).toBe(true);
    // A naive string compare would also misplace this at an earlier segment
    // ('9' > '2' byte-wise), the same trap one level up.
    expect(isVersionInRange("9.0.0", { min: "10.0.0", max: "20.0.0" })).toBe(false);
  });

  test("a version with fewer segments than the range is padded with zero, not misread as smaller by string length", () => {
    expect(isVersionInRange("2.1", { min: "2.1.0", max: "2.1.5" })).toBe(true);
    expect(isVersionInRange("2", { min: "1.0.0", max: "3.0.0" })).toBe(true);
  });
});
