// doctor's pure report assembly (docs/issues/ISS-0021.md) — takes already
// -gathered facts (running version, ledger presence, absences, recorded
// per-session cc_version, worktree gaps) and renders the four sections
// plus the exit-code rule: 0 when nothing degrades, nonzero when
// anything does, with every finding named individually (never hidden
// inside a summary count).
// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { existsSync as existsSyncFn, readFileSync as readFileSyncFn } from "node:fs";
import { ABSENT_MARKER } from "../render/absent.js";
import { TESTED_CLAUDE_CODE_RANGE } from "./version.js";
import { joinPath } from "../core/paths.js";
import { skillSource } from "../install/skillSource.js";
import { readInstallBackup } from "../install/installBackup.js";

const existsSync = existsSyncFn as (path: string) => boolean;
const readFileSync = readFileSyncFn as (path: string, encoding: "utf8") => string;

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

export interface SkillDriftFinding {
  kind: "skill-drift";
  message: string;
}

export interface DoctorRepoInput {
  // The resolved repo root (rescue Ruling D, finding 200 S1): the caller
  // must pass the repo root it already resolved (e.g. via
  // resolveAttribution), never a raw, un-resolved `process.cwd()` -- a
  // doctor invocation from a subdirectory would otherwise silently miss the
  // skill installed at the repo root.
  cwd: string;
}

// Drift is doctor's job (ISS-0034 ruling 3): compares an INSTALLED skill's
// bytes against the running package's canonical text and names it, once,
// as a finding. Never silently rewrites the installed copy -- that decision
// belongs to the operator (re-run `coreartifact init`), not to doctor,
// which is read-only everywhere else too. Silent when no skill was
// installed at all (a `--no-skill` install, or a repo running init from
// before this feature shipped) -- absence is not drift.
//
// Rescue Ruling C (finding 199 S1): the comparison runs ONLY when the
// install backup itself recorded that `init` installed the skill at this
// path. A file at the same path with no backup record is not ours to judge
// -- it is either a pre-existing user file init deliberately skipped
// (Ruling F) or a hand-authored skill from before this feature shipped;
// either way, silence, per acceptance criteria #4/#5.
export async function report(input: DoctorRepoInput): Promise<SkillDriftFinding[]> {
  const findings: SkillDriftFinding[] = [];
  const skillPath = joinPath(input.cwd, ".claude", "skills", "coreartifact", "SKILL.md");
  const backup = readInstallBackup(input.cwd);
  if (backup.entries[skillPath] === undefined) return findings;
  if (existsSync(skillPath)) {
    const installed = readFileSync(skillPath, "utf8");
    if (installed !== skillSource()) {
      findings.push({
        kind: "skill-drift",
        message: `Installed skill at ${skillPath} differs from the running package's canonical text (drift) -- re-run \`coreartifact init\` to refresh it`,
      });
    }
  }
  return findings;
}
