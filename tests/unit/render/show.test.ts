// ISS-0024 R12: unit coverage for show's new check-badge section and the
// checks-heading-before-timeline ordering. Pure formatting only — below the
// seam, no ledger, no CLI subprocess (mirrors tests/unit/render/log.test.ts).
import { describe, it, expect } from "vitest";
import { renderShow, type ShowHeaderInput, type CheckBadge, type TimelineEntry } from "../../../src/render/show.js";
import { ABSENT_MARKER } from "../../../src/render/absent.js";

const baseHeader: ShowHeaderInput = {
  sessionId: "abcdef01-2222-3333-4444-555566667777",
  shaBefore: "aaa111",
  shaAfter: "bbb222",
  footprint: ["src/a.ts"],
  costUsd: 0.5,
  hasTestResults: true,
};

const baseEntries: TimelineEntry[] = [
  { kind: "lifecycle", seq: 1, ts: "2026-07-14T10:00:00.000Z", hookEventName: "SessionStart" },
];

describe("renderShow: check badges (ISS-0024 R12)", () => {
  it("renders one badge line per bound check, naming pass/fail", () => {
    const checks: CheckBadge[] = [
      { name: "riss24-pass", passed: true, truncated: false },
      { name: "riss24-fail", passed: false, truncated: false },
    ];
    const output = renderShow(baseHeader, checks, baseEntries);
    const passLine = output.split("\n").find((l) => l.includes("riss24-pass"));
    const failLine = output.split("\n").find((l) => l.includes("riss24-fail"));
    expect(passLine?.toLowerCase()).toMatch(/pass/);
    expect(failLine?.toLowerCase()).toMatch(/fail/);
  });

  it("names the truncated flag only when set", () => {
    const checks: CheckBadge[] = [{ name: "riss24-trunc", passed: true, truncated: true }];
    const output = renderShow(baseHeader, checks, baseEntries);
    expect(output).toMatch(/riss24-trunc.*truncated/);
  });

  it("renders no check section at all for zero bound checks (never an empty badge block)", () => {
    const withChecks = renderShow(baseHeader, [{ name: "x", passed: true, truncated: false }], baseEntries);
    const withoutChecks = renderShow(baseHeader, [], baseEntries);
    expect(withoutChecks.split("\n\n").length).toBeLessThan(withChecks.split("\n\n").length);
    expect(withoutChecks).not.toMatch(/check:/);
  });

  it("the cost line (header) still precedes the timeline regardless of the checks section", () => {
    const checks: CheckBadge[] = [{ name: "x", passed: true, truncated: false }];
    const output = renderShow(baseHeader, checks, baseEntries);
    const lines = output.split("\n");
    const costLineIndex = lines.findIndex((l) => /derived/i.test(l));
    const timelineIndex = lines.findIndex((l) => /\[\d+\]/.test(l));
    expect(costLineIndex).toBeGreaterThanOrEqual(0);
    expect(timelineIndex).toBeGreaterThanOrEqual(0);
    expect(costLineIndex).toBeLessThan(timelineIndex);
  });
});

describe("renderShow: session-level test-results-absent (ISS-0024 S1)", () => {
  it("renders one explicit tests: absent-marker line when the session has no test_results row at all", () => {
    const output = renderShow({ ...baseHeader, hasTestResults: false }, [], baseEntries);
    const testsLine = output.split("\n").find((l) => l.startsWith("tests:"));
    expect(testsLine).toBeDefined();
    expect(testsLine).toContain(ABSENT_MARKER);
  });

  it("never renders the session-level tests-absent line when the session has a test_results row (including a claimed zero)", () => {
    const output = renderShow({ ...baseHeader, hasTestResults: true }, [], baseEntries);
    const testsLine = output.split("\n").find((l) => l.startsWith("tests:"));
    expect(testsLine).toBeUndefined();
  });
});
