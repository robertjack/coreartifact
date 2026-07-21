// doctor's pure report assembly (docs/issues/ISS-0021.md) — takes already
// -gathered facts (running version, ledger presence, absences, recorded
// per-session cc_version, worktree gaps) and renders the four sections
// plus the exit-code rule: 0 when nothing degrades, nonzero when
// anything does, with every finding named individually (never hidden
// inside a summary count).
import { ABSENT_MARKER } from "../render/absent.js";
import { TESTED_CLAUDE_CODE_RANGE } from "./version.js";

export interface DoctorAbsenceInput {
  session_id: string;
  facet: string;
  reason: string;
}

export interface DoctorSessionVersionInput {
  session_id: string;
  cc_version: string;
}

export interface DoctorWorktreeGapInput {
  checkoutPath: string;
}

export interface DoctorReportInput {
  runningVersion: string | null;
  ledgerExists: boolean;
  absences: DoctorAbsenceInput[];
  sessionVersions: DoctorSessionVersionInput[];
  worktreeGaps: DoctorWorktreeGapInput[];
  // Set when the ledger exists but could not be read (mid-creation, a
  // truncated/corrupt file, or a lock held by a concurrent writer — F132,
  // F135). Read fails toward a named "we don't know", never a crash: when
  // set, sections 3's absences/session-version lines are skipped (the data
  // is unreadable, not zero) but sections 1, 2 and 4 still render.
  ledgerReadError?: string | null;
  // Set when the worktree-gap scan itself could not run (e.g. cwd is not a
  // git repository — F134/F136). Read fails toward a named finding rather
  // than propagating the raw error.
  worktreeScanError?: string | null;
}

export interface DoctorReport {
  lines: string[];
  exitCode: number;
}

export function buildDoctorReport(input: DoctorReportInput): DoctorReport {
  const lines: string[] = [];
  const findings: string[] = [];

  // Section 1: running Claude Code version.
  if (input.runningVersion !== null) {
    lines.push(`Running Claude Code version: ${input.runningVersion}`);
  } else {
    const finding = `Running Claude Code version: ${ABSENT_MARKER} (claude --version was unavailable or unparseable — doctor cannot vouch for compatibility it cannot see)`;
    lines.push(finding);
    findings.push(finding);
  }

  // Section 2: tested version range — one line naming both bounds.
  lines.push(`Tested Claude Code range: ${TESTED_CLAUDE_CODE_RANGE.min} - ${TESTED_CLAUDE_CODE_RANGE.max}`);

  // Section 3: every facet currently ABSENT, with its reason (read-only:
  // doctor never triggers ledger creation, so a missing ledger is itself
  // named as a finding rather than silently yielding zero absences).
  if (!input.ledgerExists) {
    const finding = "No ledger found for this repo (doctor never creates one — run `coreartifact log` first)";
    lines.push(finding);
    findings.push(finding);
  } else if (input.ledgerReadError != null) {
    // The ledger exists but couldn't be read (mid-creation, corrupt, or
    // locked by a concurrent writer) — a named "we don't know", never a
    // crash (F132/F135, degradation law).
    const finding = `Ledger unreadable: ${input.ledgerReadError}`;
    lines.push(finding);
    findings.push(finding);
  } else {
    for (const absence of input.absences) {
      const finding = `Session ${absence.session_id}: facet "${absence.facet}" is ${ABSENT_MARKER} — ${absence.reason}`;
      lines.push(finding);
      findings.push(finding);
    }
    for (const sessionVersion of input.sessionVersions) {
      lines.push(
        `Session ${sessionVersion.session_id}: recorded Claude Code version ${sessionVersion.cc_version}`,
      );
    }
  }

  // Section 4: worktree propagation gaps.
  if (input.worktreeScanError != null) {
    const finding = `Worktree scan unavailable: ${input.worktreeScanError}`;
    lines.push(finding);
    findings.push(finding);
  } else {
    for (const gap of input.worktreeGaps) {
      const finding = `Worktree missing settings file: ${gap.checkoutPath}`;
      lines.push(finding);
      findings.push(finding);
    }
  }

  return { lines, exitCode: findings.length > 0 ? 1 : 0 };
}
