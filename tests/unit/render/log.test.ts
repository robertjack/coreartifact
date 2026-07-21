import { describe, it, expect } from "vitest";
import {
  renderSessionLine,
  renderSessionLines,
  renderIngestReport,
  renderWorktreeGapWarnings,
  renderNoRegisteredRepos,
  renderRepoUnavailable,
  type SessionLineInput,
} from "../../../src/render/log.js";
import { ABSENT_MARKER } from "../../../src/render/absent.js";
import type { IngestReport } from "../../../src/ingest/index.js";

const baseInput: SessionLineInput = {
  sessionId: "abcdef01-2222-3333-4444-555566667777",
  repoRoot: "/repos/example",
  status: "closed-clean",
  kind: "headless",
  startedAt: "2026-07-14T10:00:00.000Z",
  commandCount: 3,
  footprintCount: 2,
  costUsd: 0.555957,
  checksPass: 1,
  checksFail: 1,
};

describe("renderSessionLine", () => {
  it("carries short id, repo, status, kind, start time, command count and footprint count", () => {
    const line = renderSessionLine(baseInput);
    expect(line).toContain("abcdef01");
    expect(line).toContain("/repos/example");
    expect(line).toContain("closed-clean");
    expect(line).toContain("headless");
    expect(line).toContain("2026-07-14T10:00:00.000Z");
    expect(line).toContain("3");
    expect(line).toContain("2");
  });

  it("renders a null kind (the drift fallback) as the shared absent marker, never a blank or a guessed kind", () => {
    const line = renderSessionLine({ ...baseInput, kind: null });
    expect(line).toContain(ABSENT_MARKER);
    expect(line).not.toMatch(/headless/);
    expect(line).not.toMatch(/interactive/);
  });

  it("distinguishes a zero command count from the absent marker (never conflates 'no commands ran' with 'we don't know')", () => {
    const zeroCommands = renderSessionLine({ ...baseInput, commandCount: 0 });
    const absentKind = renderSessionLine({ ...baseInput, kind: null });
    expect(zeroCommands).not.toContain(ABSENT_MARKER);
    expect(absentKind).toContain(ABSENT_MARKER);
  });

  it("renders a present cost_usd with a derived marker distinguishing it from spool-borne facets (ISS-0019)", () => {
    const line = renderSessionLine({ ...baseInput, costUsd: 0.555957 });
    expect(line).toContain("0.555957");
    expect(line).toMatch(/derived/i);
  });

  it("renders an absent cost_usd (unavailable/drifted transcript, or an unpinned model) as the shared absent marker, never zero", () => {
    const line = renderSessionLine({ ...baseInput, costUsd: null });
    expect(line).toContain(ABSENT_MARKER);
    expect(line).not.toContain("0  ");
  });

  it("ISS-0024: renders a checks column summarizing pass/fail counts, both visible", () => {
    const line = renderSessionLine({ ...baseInput, checksPass: 2, checksFail: 1 });
    expect(line.toLowerCase()).toMatch(/2 pass/);
    expect(line.toLowerCase()).toMatch(/1 fail/);
  });

  it("ISS-0024: zero bound checks renders a real zero, never the absent marker (checks are a countable fact)", () => {
    const line = renderSessionLine({ ...baseInput, checksPass: 0, checksFail: 0, kind: "headless" });
    expect(line.toLowerCase()).toMatch(/0 pass/);
    expect(line.toLowerCase()).toMatch(/0 fail/);
  });

  // 2026-07-21 dogfood finding (see src/check/binding.ts): single-open
  // bindings are an overlay on the pass/fail counts, marked only when
  // nonzero — the all-explicit common case stays byte-identical.
  it("appends a single-open overlay to the checks column when any check was auto-bound", () => {
    const line = renderSessionLine({ ...baseInput, checksPass: 2, checksFail: 1, checksSingleOpen: 1 });
    expect(line).toContain("checks:2 pass, 1 fail (1 single-open)");
  });

  it("renders no single-open marker when every binding was explicit — byte-identical to a line with no overlay field at all", () => {
    const explicit = renderSessionLine({ ...baseInput, checksSingleOpen: 0 });
    expect(explicit).toBe(renderSessionLine(baseInput));
    expect(explicit).not.toContain("single-open");
  });
});

describe("renderSessionLines", () => {
  it("prints an explicit empty-state line for zero sessions, never nothing", () => {
    const output = renderSessionLines([]);
    expect(output.length).toBeGreaterThan(0);
    expect(output).toMatch(/no session/i);
  });

  it("unions multiple sessions across repos into one line each", () => {
    const other: SessionLineInput = { ...baseInput, sessionId: "99998888-aaaa-bbbb-cccc-ddddeeeeffff", repoRoot: "/repos/other" };
    const output = renderSessionLines([baseInput, other]);
    expect(output.split("\n")).toHaveLength(2);
    expect(output).toContain("/repos/example");
    expect(output).toContain("/repos/other");
  });
});

describe("renderIngestReport", () => {
  it("keeps the skipped line number in the printed report (the ingest slice's contract)", () => {
    const report: IngestReport = {
      eventsInserted: 1,
      sessionsTouched: 1,
      skipped: [{ lineNo: 42, reason: "line is not valid JSON" }],
      warnings: [],
    };
    const output = renderIngestReport(report, "/repos/example");
    expect(output).toContain("42");
    expect(output).toContain("line is not valid JSON");
    expect(output).toContain("/repos/example");
  });
});

describe("renderWorktreeGapWarnings", () => {
  it("names the affected worktree checkout path", () => {
    const output = renderWorktreeGapWarnings([{ checkoutPath: "/repos/example/worktrees/foo" }]);
    expect(output).toMatch(/warn/i);
    expect(output).toContain("/repos/example/worktrees/foo");
  });

  it("stays silent (empty string) for zero gaps", () => {
    expect(renderWorktreeGapWarnings([])).toBe("");
  });
});

describe("renderNoRegisteredRepos", () => {
  it("mentions the registry", () => {
    expect(renderNoRegisteredRepos()).toMatch(/regist/i);
  });
});

describe("renderRepoUnavailable", () => {
  it("names the unreachable repo and folds the reason in as a warning, never a thrown error", () => {
    const output = renderRepoUnavailable("/repos/gone", "ENOENT: no such file or directory");
    expect(output).toMatch(/warn/i);
    expect(output).toContain("/repos/gone");
    expect(output).toContain("ENOENT");
  });
});
