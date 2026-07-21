// Unit coverage for src/doctor/report.ts's pure assembly — specifically the
// two degradation paths added for F132/F135 (ledger unreadable) and
// F134/F136 (worktree scan unavailable): both must render as a single
// named finding, drive a nonzero exit, and leave sections 1/2/4 (or 1/2/3)
// intact rather than crashing or silently dropping the section.
import { describe, expect, it } from "vitest";
import { buildDoctorReport } from "../../../src/doctor/report.js";

const BASE = {
  runningVersion: "2.1.209",
  absences: [],
  sessionVersions: [],
  worktreeGaps: [],
};

describe("doctor/report: ledgerReadError degradation (F132/F135)", () => {
  it("renders a named 'Ledger unreadable' finding and drives a nonzero exit when the ledger exists but can't be read", () => {
    const report = buildDoctorReport({
      ...BASE,
      ledgerExists: true,
      ledgerReadError: "database is locked",
    });

    expect(report.exitCode).not.toBe(0);
    expect(report.lines.some((line) => line === "Ledger unreadable: database is locked")).toBe(true);
    // Sections 1 and 2 still render — the crash never took the whole report.
    expect(report.lines.some((line) => line.startsWith("Running Claude Code version:"))).toBe(true);
    expect(report.lines.some((line) => line.startsWith("Tested Claude Code range:"))).toBe(true);
  });

  it("a readable ledger with zero absences still exits 0 (no regression from the new branch)", () => {
    const report = buildDoctorReport({
      ...BASE,
      ledgerExists: true,
      ledgerReadError: null,
    });
    expect(report.exitCode).toBe(0);
    expect(report.lines.some((line) => line.startsWith("Ledger unreadable:"))).toBe(false);
  });
});

describe("doctor/report: worktreeScanError degradation (F134/F136)", () => {
  it("renders a named 'Worktree scan unavailable' finding and drives a nonzero exit instead of a raw git error", () => {
    const report = buildDoctorReport({
      ...BASE,
      ledgerExists: false,
      worktreeScanError: "Command failed: git worktree list --porcelain",
    });

    expect(report.exitCode).not.toBe(0);
    expect(
      report.lines.some(
        (line) => line === "Worktree scan unavailable: Command failed: git worktree list --porcelain",
      ),
    ).toBe(true);
  });

  it("real worktree gaps still render when the scan itself succeeded", () => {
    const report = buildDoctorReport({
      ...BASE,
      ledgerExists: false,
      worktreeGaps: [{ checkoutPath: "/some/other/worktree" }],
    });
    expect(report.exitCode).not.toBe(0);
    expect(report.lines.some((line) => line === "Worktree missing settings file: /some/other/worktree")).toBe(
      true,
    );
  });
});
