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
  for (const gap of input.worktreeGaps) {
    const finding = `Worktree missing settings file: ${gap.checkoutPath}`;
    lines.push(finding);
    findings.push(finding);
  }

  return { lines, exitCode: findings.length > 0 ? 1 : 0 };
}
