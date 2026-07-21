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

// 2026-07-21 dogfood finding: a single-open-bound check (a check run with no
// --session, auto-attributed to the lone open session) rendered identically
// to an explicitly bound one, so a human-run check in a second terminal was
// indistinguishable from the agent's own evidence. The badge line now names
// the single-open case; explicit stays unmarked as the default.
describe("renderShow: check badge binding marker (single-open)", () => {
  it("marks a single-open-bound check on its badge line", () => {
    const checks: CheckBadge[] = [{ name: "build", passed: true, truncated: false, boundBy: "single-open" }];
    const output = renderShow(baseHeader, checks, baseEntries);
    expect(output).toContain("check: build  pass  bound_by: single-open");
  });

  it("renders an explicit binding unmarked — byte-identical to a badge carrying no boundBy at all", () => {
    const explicit: CheckBadge[] = [{ name: "test", passed: false, truncated: false, boundBy: "explicit" }];
    const bare: CheckBadge[] = [{ name: "test", passed: false, truncated: false }];
    expect(renderShow(baseHeader, explicit, baseEntries)).toBe(renderShow(baseHeader, bare, baseEntries));
    expect(renderShow(baseHeader, explicit, baseEntries)).not.toMatch(/bound_by/);
  });

  it("composes with the truncated flag on one line", () => {
    const checks: CheckBadge[] = [{ name: "t", passed: true, truncated: true, boundBy: "single-open" }];
    const output = renderShow(baseHeader, checks, baseEntries);
    expect(output).toContain("check: t  pass  truncated: true  bound_by: single-open");
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
