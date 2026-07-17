// ISS-0021 acceptance tests — `coreartifact doctor`, the drift reporter.
//
// Test-harness contract: reuses the acceptance harness's primitives verbatim
// from ../harness/index.js (tmpdir-repo factory, CLI runner, worktree helper,
// readLedger) plus the fixtures layer's already-shipped, independent typed
// access: ../../fixtures/loader.js (loadFixtureStream, loadTranscriptPair,
// loadClaudeVersionOutputShape — the recorded `claude --version` output
// shape this issue's shim reuses rather than hardcoding a guessed string)
// and ../../fixtures/transcriptReplay.js (buildSubstitutedTranscript — the
// one sanctioned substitution).
//
// `doctor` itself (src/cli/commands/doctor.ts, not yet registered in
// src/cli/index.ts's COMMANDS table) is never imported directly: every
// assertion below drives the built CLI subprocess (`coreartifact doctor`)
// and reads back through already-shipped, independent modules — the ledger
// (src/core/ledger.ts), the absence-record contract (src/core/absence.ts,
// ISS-0014), the absent marker (src/render/absent.ts, ISS-0007) and the
// worktree-gap module (src/worktree-gap.ts, ISS-0007) — never a guessed
// doctor-owned path. Because the command is unregistered today, `runCli`
// itself already returns the dispatcher's "unknown command" exit 1 for
// every scenario below: every test here is red for that reason alone, with
// no collection/import error, exactly as the harness's other
// not-yet-wired-command acceptance suites (ISS-0007, ISS-0019, ISS-0020)
// are structured.
//
// The controlled-PATH mechanism (gotchas.md entry 3): `runCli`'s
// `RunCliOptions` carries no PATH override, and its env is built from
// `baseHermeticEnv(home)`, which allowlist-copies PATH out of the REAL
// `process.env` of the process that calls `runCli` — i.e. this test's own
// process. Temporarily reassigning `process.env.PATH` here (restored in a
// `finally`) is therefore the sanctioned way to control what the CLI
// subprocess sees on PATH, without touching the harness itself. The
// present-case shim is a directory holding a `claude` script emitting the
// recorded output shape, prepended ahead of the real PATH (git must still
// resolve). The absent-case PATH holds only a symlink to the real `git`
// binary (resolved once, outside any override, via `which`) so worktree-gap
// scanning still works while `claude` is unresolvable by construction —
// never a denylist-style deletion of "whichever PATH entry has claude".
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmpRepo, runCli, addWorktree, replayLines, type TmpRepo } from "../harness/index.js";
import { loadFixtureStream, loadTranscriptPair, loadClaudeVersionOutputShape } from "../../fixtures/loader.js";
import { buildSubstitutedTranscript } from "../../fixtures/transcriptReplay.js";
import { getPaths } from "../../../src/core/paths.js";
import { openLedger } from "../../../src/core/ledger.js";
import { getSessionAbsences, COST_ABSENCE_REASONS } from "../../../src/core/absence.js";
import { ABSENT_MARKER } from "../../../src/render/absent.js";
// Operator amendment 2026-07-17 (gotcha #7, second sighting — the PRD-0003
// recording pass's range bump tripped the hard-pinned "2.1.211" literals):
// the criterion names "a single named code constant, rendered by doctor",
// so the constant IS the oracle — assert containment of ITS bounds, never
// a snapshot of today's values.
import { TESTED_CLAUDE_CODE_RANGE } from "../../../src/doctor/version.js";

const tmpRepos: TmpRepo[] = [];
const scratchDirs: string[] = [];

afterAll(async () => {
  for (const repo of tmpRepos) {
    await repo.cleanup();
  }
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** A directory holding only a `claude` script emitting `outputShape` on stdout, exit 0. */
function makeClaudeShimDir(outputShape: string): string {
  const dir = makeScratchDir("coreartifact-doctor-shim-present-");
  const scriptPath = join(dir, "claude");
  writeFileSync(scriptPath, `#!/bin/sh\nprintf '%s\\n' '${outputShape.replace(/'/g, "'\\''")}'\n`);
  chmodSync(scriptPath, 0o755);
  return dir;
}

/** A directory holding ONLY a symlink to the real `git` binary — no `claude` anywhere on it. */
function makeGitOnlyDir(): string {
  const realGitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const dir = makeScratchDir("coreartifact-doctor-shim-absent-");
  symlinkSync(realGitPath, join(dir, "git"));
  return dir;
}

async function withPath<T>(pathValue: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = pathValue;
  try {
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

function sessionIdOf(fixtureLine: string): string {
  const parsed = JSON.parse(fixtureLine) as { session_id?: unknown };
  if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) {
    throw new Error("test setup invariant: fixture line has no session_id");
  }
  return parsed.session_id;
}

function transformLines(lines: string[], fn: (obj: Record<string, unknown>) => void): string[] {
  return lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    fn(parsed);
    return JSON.stringify(parsed);
  });
}

async function initRepo(): Promise<TmpRepo> {
  const repo = await createTmpRepo();
  tmpRepos.push(repo);
  const init = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
  expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);
  return repo;
}

async function runDoctor(repo: TmpRepo) {
  return runCli(["doctor"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
}

describe("ISS-0021 doctor: the drift reporter", () => {
  it(
    "R8 Doctor. coreartifact doctor (read-only) reports: the running Claude Code version (obtained by executing claude --version; rendered ABSENT when the binary is unavailable — asserted with a controlled PATH), the tested version range (named constant, the README's stamp), every facet currently ABSENT with its reason, and any worktree missing the settings file. Exit 0 when nothing degrades; nonzero, naming each finding, when anything does.",
    async () => {
      const repo = await initRepo();
      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];

      // --- A cost-facet absence: a session whose transcript path is
      // guaranteed nonexistent, ingested via `log` (doctor never ingests
      // itself — it only reads what `log` already recorded). ---
      const missingScratchDir = makeScratchDir("coreartifact-iss21-r8-missing-");
      const missingTranscriptPath = join(missingScratchDir, "nonexistent.transcript.jsonl");
      const missingSessionId = "iss21-r8-missing-transcript-session";
      const missingLines = transformLines(loadFixtureStream("cost-headless"), (obj) => {
        obj.cwd = repo.root;
        obj.session_id = missingSessionId;
        obj.transcript_path = missingTranscriptPath;
      });
      await replayLines(missingLines, command);
      const ingestResult = await runCli(["log"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(ingestResult.exitCode, `test setup invariant: log/ingest did not exit 0; stderr: ${ingestResult.stderr}`).toBe(0);

      const absences = (() => {
        const handle = openLedger(paths.ledger);
        try {
          return getSessionAbsences(handle.db, missingSessionId);
        } finally {
          handle.close();
        }
      })();
      const costAbsence = absences.find((a) => a.facet === "cost");
      expect(costAbsence, "test setup invariant: the missing-transcript session must carry a cost absence").toBeDefined();
      expect(costAbsence!.reason).toBe(COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);

      // --- A worktree gap: created AFTER init (never propagated), with its
      // settings file removed defensively so the gap holds regardless of any
      // future propagation nuance. ---
      const gapWorktree = await addWorktree(repo, "iss21-r8-worktree-gap");
      rmSync(join(gapWorktree.checkoutPath, ".claude", "settings.local.json"), { force: true });

      const shimDir = makeClaudeShimDir(loadClaudeVersionOutputShape());
      const doctorResult = await withPath(`${shimDir}:${process.env.PATH}`, () => runDoctor(repo));
      const output = `${doctorResult.stdout}\n${doctorResult.stderr}`;

      const expectedVersionToken = loadClaudeVersionOutputShape().split(/\s+/)[0]!;
      expect(output, "doctor did not report the running Claude Code version").toContain(expectedVersionToken);
      expect(output, "doctor did not report the tested version range's lower bound").toContain(
        TESTED_CLAUDE_CODE_RANGE.min,
      );
      expect(output, "doctor did not report the tested version range's upper bound").toContain(
        TESTED_CLAUDE_CODE_RANGE.max,
      );
      expect(
        output,
        "doctor did not report the ABSENT cost facet's reason for the missing-transcript session",
      ).toContain(COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);
      expect(output, "doctor did not name the session carrying the ABSENT facet").toContain(missingSessionId);
      expect(output, "doctor did not name the worktree missing its settings file").toContain(gapWorktree.checkoutPath);
      expect(
        doctorResult.exitCode,
        "doctor exited 0 despite an ABSENT facet and a worktree gap both present — it must exit nonzero when anything degrades",
      ).not.toBe(0);
    },
    60000,
  );

  it(
    "The Claude Code version is obtained by executing claude --version and parsing the first whitespace-separated token of its single output line (the recorded shape is 2.1.211 (Claude Code)); any other output shape or a missing binary renders the running version ABSENT — asserted with a controlled PATH shim for the present case and a PATH without the binary for the absent case.",
    async () => {
      const repo = await initRepo();
      const recordedShape = loadClaudeVersionOutputShape();
      const expectedToken = recordedShape.split(/\s+/)[0]!;

      // --- Present case: a shim `claude` first on PATH, emitting the
      // recorded output shape verbatim. ---
      const presentShimDir = makeClaudeShimDir(recordedShape);
      const presentResult = await withPath(`${presentShimDir}:${process.env.PATH}`, () => runDoctor(repo));
      const presentOutput = `${presentResult.stdout}\n${presentResult.stderr}`;
      expect(
        presentOutput,
        "doctor did not render the parsed first token of the shim's claude --version output",
      ).toContain(expectedToken);

      // --- Absent case: a PATH containing no `claude` binary at all (only
      // a symlink to the real `git`, so worktree-gap scanning still works). ---
      const gitOnlyDir = makeGitOnlyDir();
      const absentResult = await withPath(gitOnlyDir, () => runDoctor(repo));
      const absentOutput = `${absentResult.stdout}\n${absentResult.stderr}`;
      expect(
        absentOutput,
        "doctor did not render the ABSENT marker for the running Claude Code version when claude is unavailable on PATH",
      ).toContain(ABSENT_MARKER);
    },
    60000,
  );

  it(
    "The tested version range is a single named code constant reporting its lower and upper bounds, rendered by doctor.",
    async () => {
      const repo = await initRepo();
      const gitOnlyDir = makeGitOnlyDir();
      const doctorResult = await withPath(gitOnlyDir, () => runDoctor(repo));
      const output = `${doctorResult.stdout}\n${doctorResult.stderr}`;

      const rangeLine = output
        .split("\n")
        .find((line) => line.includes(TESTED_CLAUDE_CODE_RANGE.min) && line.includes(TESTED_CLAUDE_CODE_RANGE.max));
      expect(
        rangeLine,
        `doctor did not render a single line naming both the tested range's lower bound (${TESTED_CLAUDE_CODE_RANGE.min}) and upper bound (${TESTED_CLAUDE_CODE_RANGE.max}). Full output:\n${output}`,
      ).toBeDefined();
    },
    60000,
  );

  it(
    "When a session's transcript was readable at enrichment time, doctor additionally reports that session's recorded Claude Code version from its transcript-derived version field, as drift context.",
    async () => {
      const repo = await initRepo();
      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];

      const pair = loadTranscriptPair("cost-headless");
      const sessionId = sessionIdOf(loadFixtureStream("cost-headless")[0]!);

      const workDir = makeScratchDir("coreartifact-iss21-ccversion-");
      const substituted = buildSubstitutedTranscript("cost-headless", workDir);
      const rebased = transformLines(substituted.lines, (obj) => {
        obj.cwd = repo.root;
      });
      await replayLines(rebased, command);
      const ingestResult = await runCli(["log"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(ingestResult.exitCode, `test setup invariant: log/ingest did not exit 0; stderr: ${ingestResult.stderr}`).toBe(0);

      const recordedCcVersion = (() => {
        const handle = openLedger(paths.ledger);
        try {
          const row = handle.db
            .prepare("SELECT cc_version FROM sessions WHERE session_id = ?")
            .get(sessionId) as { cc_version: string | null } | undefined;
          return row?.cc_version ?? null;
        } finally {
          handle.close();
        }
      })();
      expect(
        recordedCcVersion,
        "test setup invariant: the readable-transcript session must carry a recorded cc_version",
      ).toBe(pair.claudeCodeVersion);

      const gitOnlyDir = makeGitOnlyDir();
      const doctorResult = await withPath(gitOnlyDir, () => runDoctor(repo));
      const output = `${doctorResult.stdout}\n${doctorResult.stderr}`;

      expect(
        output,
        "doctor did not report the readable-transcript session's recorded Claude Code version as drift context",
      ).toContain(pair.claudeCodeVersion);
      expect(output, "doctor's drift-context line did not name the session it belongs to").toContain(sessionId);
    },
    60000,
  );

  it(
    "doctor is read-only: running it never creates a ledger where none exists, never mutates the spool, the ledger, the registry or the global root, and never prompts; it exits 0 when nothing degrades and nonzero naming each finding when anything does.",
    async () => {
      // --- Phase 1: a freshly init'd repo with NO ledger yet (init only
      // creates directories; the ledger is created lazily by the first
      // ingest, per src/cli/commands/init.ts). Doctor must not create one,
      // must report the missing ledger as a finding (nonzero), and must
      // leave the registry byte-identical. ---
      const repo = await initRepo();
      const paths = getPaths(repo.root);
      expect(existsSync(paths.ledger), "test setup invariant: no ledger must exist before doctor runs").toBe(false);

      const registryBefore = readFileSync(repo.registryPath, "utf8");
      const registryRootEntriesBefore = existsSync(repo.registryRoot) ? readdirSync(repo.registryRoot).sort() : [];

      const noLedgerResult = await runDoctor(repo);

      expect(
        existsSync(paths.ledger),
        "doctor created a ledger where none existed before it ran — doctor must never trigger ledger creation",
      ).toBe(false);
      expect(
        readFileSync(repo.registryPath, "utf8"),
        "doctor mutated the registry file",
      ).toBe(registryBefore);
      expect(
        existsSync(repo.registryRoot) ? readdirSync(repo.registryRoot).sort() : [],
        "doctor mutated the global operator-state root's file listing",
      ).toEqual(registryRootEntriesBefore);
      expect(
        noLedgerResult.exitCode,
        "doctor exited 0 in a repo with no ledger — a missing ledger must be reported as a finding (nonzero)",
      ).not.toBe(0);

      // --- Phase 2: a clean repo — ingested via `log` (never by doctor
      // itself), a readable transcript so cost is not ABSENT, no worktree
      // gaps, and the claude shim present on PATH — must exit 0. ---
      const cleanRepo = await initRepo();
      const cleanPaths = getPaths(cleanRepo.root);
      const cleanCommand = ["node", cleanPaths.hookArtifact, cleanRepo.root];
      const cleanWorkDir = makeScratchDir("coreartifact-iss21-readonly-clean-");
      const cleanSubstituted = buildSubstitutedTranscript("cost-headless", cleanWorkDir);
      const cleanRebased = transformLines(cleanSubstituted.lines, (obj) => {
        obj.cwd = cleanRepo.root;
      });
      await replayLines(cleanRebased, cleanCommand);
      const cleanIngest = await runCli(["log"], {
        cwd: cleanRepo.root,
        home: cleanRepo.home,
        registryPath: cleanRepo.registryPath,
      });
      expect(cleanIngest.exitCode, `test setup invariant: log/ingest did not exit 0; stderr: ${cleanIngest.stderr}`).toBe(0);

      const cleanSessionId = sessionIdOf(loadFixtureStream("cost-headless")[0]!);
      const cleanAbsences = (() => {
        const handle = openLedger(cleanPaths.ledger);
        try {
          return getSessionAbsences(handle.db, cleanSessionId);
        } finally {
          handle.close();
        }
      })();
      expect(cleanAbsences, "test setup invariant: the readable-transcript session must carry no absences").toEqual([]);

      const ledgerBytesBefore = readFileSync(cleanPaths.ledger);
      const shimDir = makeClaudeShimDir(loadClaudeVersionOutputShape());
      const cleanDoctorResult = await withPath(`${shimDir}:${process.env.PATH}`, () => runDoctor(cleanRepo));

      expect(
        readFileSync(cleanPaths.ledger).equals(ledgerBytesBefore),
        "doctor mutated the ledger file",
      ).toBe(true);
      expect(
        cleanDoctorResult.exitCode,
        `doctor did not exit 0 for a clean repo (readable transcript, no worktree gaps, claude present); stderr: ${cleanDoctorResult.stderr}`,
      ).toBe(0);
    },
    60000,
  );
});
