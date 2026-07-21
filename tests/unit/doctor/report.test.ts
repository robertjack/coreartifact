// Unit coverage for src/doctor/report.ts's pure assembly — specifically the
// two degradation paths added for F132/F135 (ledger unreadable) and
// F134/F136 (worktree scan unavailable): both must render as a single
// named finding, drive a nonzero exit, and leave sections 1/2/4 (or 1/2/3)
// intact rather than crashing or silently dropping the section.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoctorReport, report } from "../../../src/doctor/report.js";
import { skillSource } from "../../../src/install/skillSource.js";
import { installBackupPath } from "../../../src/install/installBackup.js";

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

describe("doctor/report: report() skill drift (ISS-0034)", () => {
  function withTempDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "cart-report-skill-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function skillPath(dir: string): string {
    return join(dir, ".claude", "skills", "coreartifact", "SKILL.md");
  }

  // Rescue Ruling C (finding 199 S1): the drift comparison only runs when
  // the install backup itself recorded that `init` installed this skill --
  // seeded here by hand (rather than going through `installSkill`) so this
  // suite stays a narrow, targeted test of `report()` alone.
  function seedBackupRecord(dir: string, path: string): void {
    mkdirSync(join(dir, ".coreartifact"), { recursive: true });
    writeFileSync(installBackupPath(dir), JSON.stringify({ v: 1, entries: { [path]: { existed: false } } }));
  }

  it("stays silent when no skill is installed", async () => {
    await withTempDir(async (dir) => {
      const findings = await report({ cwd: dir });
      expect(findings).toEqual([]);
    });
  });

  it("stays silent when the installed skill matches the canonical text", async () => {
    await withTempDir(async (dir) => {
      const path = skillPath(dir);
      mkdirSync(join(dir, ".claude", "skills", "coreartifact"), { recursive: true });
      writeFileSync(path, skillSource());
      seedBackupRecord(dir, path);
      const findings = await report({ cwd: dir });
      expect(findings).toEqual([]);
    });
  });

  it("names a skill-drift finding when the installed bytes differ from the canonical text and the install was recorded in the backup", async () => {
    await withTempDir(async (dir) => {
      const path = skillPath(dir);
      mkdirSync(join(dir, ".claude", "skills", "coreartifact"), { recursive: true });
      writeFileSync(path, `${skillSource()}\nmutated\n`);
      seedBackupRecord(dir, path);
      const findings = await report({ cwd: dir });
      expect(findings).toHaveLength(1);
      expect(findings[0].kind).toBe("skill-drift");
      expect(findings[0].message.toLowerCase()).toMatch(/drift|differ/);
    });
  });

  // Rescue Ruling C's central proof: a file at our path whose bytes differ
  // from canonical but was NEVER recorded in the install backup (a
  // pre-existing user file init skipped per Ruling F, or a hand-authored
  // skill from before this feature shipped) must stay silent -- it is not
  // ours to judge.
  it("stays silent when the file differs from canonical but was never recorded in the install backup (user-authored, Ruling C)", async () => {
    await withTempDir(async (dir) => {
      const path = skillPath(dir);
      mkdirSync(join(dir, ".claude", "skills", "coreartifact"), { recursive: true });
      writeFileSync(path, "# entirely user-authored content, never installed by coreartifact\n");
      // Deliberately no seedBackupRecord call.
      const findings = await report({ cwd: dir });
      expect(findings).toEqual([]);
    });
  });
});
