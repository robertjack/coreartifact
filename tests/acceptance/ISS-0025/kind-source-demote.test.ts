// ISS-0025 acceptance tests — Kind classifier: demote-only on non-`startup`
// SessionStart sources (docs/issues/ISS-0025.md; docs/recording-pass.md
// findings 3 and 9).
//
// Test-harness contract: reuses the acceptance harness's primitives verbatim
// from ../harness/index.js (tmpdir-repo factory, CLI runner, replayLines,
// readLedger) — same pattern as ISS-0020's own drift.test.ts, the nearest
// prior art for this exact kind/absence mechanism. src/core/absence.ts and
// src/render/absent.ts already ship (this issue only adds a member/branch to
// each), so they are plain static imports, never caught dynamic ones; every
// assertion below drives ingest only through the built CLI (`log`/`show`/
// `doctor`) and reads back through the absence contract's own read API
// (getSessionAbsences), never raw SQLite writes, never a harness edit.
//
// Criteria 1 and 2 derive their streams in memory from the already-committed
// `headless` fixture (SessionStart source mutated/stripped) — mirrors
// ISS-0020's buildDriftStream, never hand-authored beyond what's committed.
// Criterion 3 reads the hand-authored `tests/fixtures/clear-source.jsonl`
// directly off disk at a fixed path, bypassing the typed manifest loader —
// the corrupt-line.jsonl precedent (tests/fixtures/corrupt-line.jsonl /
// tests/acceptance/ISS-0002/fixtures.test.ts's readNonEmptyLines), since
// clear-source.jsonl is deliberately excluded from tests/fixtures/manifest.json.
import { describe, it, expect, afterAll } from "vitest";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore -- node:sqlite has no ambient types available in this sandbox (see src/core/ledger.ts / harness/readers.ts)
import { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";
import { createTmpRepo, runCli, replayLines, readLedger, type TmpRepo } from "../harness/index.js";
import { loadFixtureStream } from "../../fixtures/loader.js";
import { getPaths } from "../../../src/core/paths.js";
import { getSessionAbsences, KIND_ABSENCE_REASONS, type AbsenceRow } from "../../../src/core/absence.js";
import { ABSENT_MARKER } from "../../../src/render/absent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
// Fixed path per the corrupt-line.jsonl precedent: clear-source.jsonl is
// deliberately excluded from tests/fixtures/manifest.json, so it is resolved
// at its own fixed, conventional path rather than discovered/globbed.
const CLEAR_SOURCE_FIXTURE_PATH = join(REPO_ROOT, "tests/fixtures/clear-source.jsonl");

interface SqliteStatementHandle {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface SqliteDatabaseHandle {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementHandle;
  close(): void;
}
const DatabaseSync = DatabaseSyncCtor as unknown as new (
  path: string,
  options?: { readOnly?: boolean },
) => SqliteDatabaseHandle;

/** Read a session's absence rows through the contract module's own read API — never raw SQLite. */
function readAbsencesForSession(ledgerPath: string, sessionId: string): AbsenceRow[] {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    return getSessionAbsences(db, sessionId);
  } finally {
    db.close();
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

function readNonEmptyLines(filePath: string): string[] {
  const raw = readFileSync(filePath, "utf8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

function readClearSourceFixtureLines(): string[] {
  if (!existsSync(CLEAR_SOURCE_FIXTURE_PATH)) {
    throw new Error(
      `clear-source fixture not found at fixed path ${CLEAR_SOURCE_FIXTURE_PATH} ` +
        "(tests/fixtures/clear-source.jsonl — hand-authored outside the typed manifest, " +
        "corrupt-line precedent; trimmed from tests/fixtures/recpass-2.1.212/headless-default.jsonl " +
        "with source set to \"clear\" and model dropped, per docs/issues/ISS-0025.md)",
    );
  }
  return readNonEmptyLines(CLEAR_SOURCE_FIXTURE_PATH);
}

async function setupRepo(tmpRepos: TmpRepo[]): Promise<{
  repo: TmpRepo;
  paths: ReturnType<typeof getPaths>;
  command: string[];
  opts: { cwd: string; home: string; registryPath: string };
  runLog: () => ReturnType<typeof runCli>;
}> {
  const repo = await createTmpRepo();
  tmpRepos.push(repo);
  const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
  expect(initResult.exitCode, `test setup invariant: init did not exit 0; stderr: ${initResult.stderr}`).toBe(0);

  const paths = getPaths(repo.root);
  const command = ["node", paths.hookArtifact, repo.root];
  const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };
  const runLog = () => runCli(["log"], opts);

  return { repo, paths, command, opts, runLog };
}

describe("ISS-0025 kind classifier: demote-only on non-startup SessionStart sources", () => {
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it(
    "Aggregating a session whose SessionStart carries a source key other than 'startup' (the recorded real case: 'clear') and NO model key yields kind ABSENT — never headless — with an absence reason that names the unverified source mode (the reason string includes the observed source value); the reason literal is a new member of KIND_ABSENCE_REASONS and is accepted by the absence-record contract's reason validation.",
    async () => {
      const { paths, command, runLog } = await setupRepo(tmpRepos);

      // Independent-oracle sanity check on the raw fixture bytes: the
      // committed headless stream's SessionStart lacks model and carries
      // source "startup" before mutation (verified by execution).
      const headlessLines = loadFixtureStream("headless");
      const headlessStart = JSON.parse(headlessLines[0]!) as Record<string, unknown>;
      expect(
        headlessStart.hook_event_name,
        "test setup invariant: the headless fixture's first line must be SessionStart",
      ).toBe("SessionStart");
      expect(
        headlessStart.model,
        "test setup invariant: the headless fixture's SessionStart must not carry a model key",
      ).toBeUndefined();
      expect(
        headlessStart.source,
        "test setup invariant: the headless fixture's SessionStart source must be 'startup' before mutation",
      ).toBe("startup");

      // Derived in memory only (never committed): the headless stream with
      // SessionStart's source overridden to the recorded real non-startup
      // case, "clear" — model stays absent throughout.
      const clearSourceLines = transformLines(headlessLines, (obj) => {
        if (obj.hook_event_name === "SessionStart") {
          obj.source = "clear";
        }
      });
      const sessionId = sessionIdOf(clearSourceLines[0]!);
      await replayLines(clearSourceLines, command);

      const logResult = await runLog();
      expect(logResult.exitCode, `log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);

      const ledger = readLedger(paths.ledger);
      const session = ledger.sessions.find((s) => s.session_id === sessionId);
      if (!session) throw new Error("no session row found for the source:'clear' session after ingest");
      expect(
        session.kind,
        "a SessionStart with source 'clear' and no model must never classify as headless (or interactive) — it must record kind ABSENT",
      ).toBeNull();

      const absences = readAbsencesForSession(paths.ledger, sessionId);
      const kindAbsence = absences.find((a) => a.facet === "kind");
      if (!kindAbsence) throw new Error("no kind-facet absence row recorded for the source:'clear' session");
      expect(
        kindAbsence.reason,
        "the absence reason must name the observed source value ('clear')",
      ).toContain("clear");
      expect(
        Object.values(KIND_ABSENCE_REASONS),
        "the reason must be a literal member of the closed KIND_ABSENCE_REASONS vocabulary (accepted by the absence-record contract's reason validation), not an ad-hoc string",
      ).toContain(kindAbsence.reason);
      expect(
        kindAbsence.reason,
        "the source-demote reason must be a NEW member, distinct from the pre-existing 'no SessionStart captured' reason",
      ).not.toBe(KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED);
      expect(
        kindAbsence.reason,
        "the source-demote reason must be a NEW member, distinct from the pre-existing end-reason-contradiction reason",
      ).not.toBe(KIND_ABSENCE_REASONS.MODEL_ABSENT_CONTRADICTED_BY_END_REASON);
    },
    30000,
  );

  it(
    "Aggregating a session whose SessionStart carries NO source key at all and no model key yields kind ABSENT with the same reason family (source reported as absent), never a classified kind — an unobserved start mode is never classified.",
    async () => {
      const { paths, command, runLog } = await setupRepo(tmpRepos);

      const headlessLines = loadFixtureStream("headless");
      const headlessStart = JSON.parse(headlessLines[0]!) as Record<string, unknown>;
      expect(
        headlessStart.model,
        "test setup invariant: the headless fixture's SessionStart must not carry a model key",
      ).toBeUndefined();
      expect(
        headlessStart.source,
        "test setup invariant: the headless fixture's SessionStart must carry a source key before it is stripped",
      ).toBeDefined();

      // Derived in memory only: the headless stream with SessionStart's
      // source key removed entirely — model stays absent throughout, and
      // (unlike the no-SessionStart-at-all case) a SessionStart line IS
      // present, it just names no source mode.
      const noSourceLines = transformLines(headlessLines, (obj) => {
        if (obj.hook_event_name === "SessionStart") {
          delete obj.source;
        }
      });
      const sessionId = sessionIdOf(noSourceLines[0]!);
      await replayLines(noSourceLines, command);

      const logResult = await runLog();
      expect(logResult.exitCode, `log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);

      const ledger = readLedger(paths.ledger);
      const session = ledger.sessions.find((s) => s.session_id === sessionId);
      if (!session) throw new Error("no session row found for the no-source session after ingest");
      expect(
        session.kind,
        "a SessionStart with no source key and no model key must never be classified — it must record kind ABSENT",
      ).toBeNull();

      const absences = readAbsencesForSession(paths.ledger, sessionId);
      const kindAbsence = absences.find((a) => a.facet === "kind");
      if (!kindAbsence) throw new Error("no kind-facet absence row recorded for the no-source session");
      expect(
        kindAbsence.reason,
        "a captured SessionStart with no source key must not reuse the 'no SessionStart captured' reason — a SessionStart line WAS captured here",
      ).not.toBe(KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED);
      expect(
        kindAbsence.reason,
        "an unobserved start mode must not reuse the pre-existing end-reason-contradiction reason either",
      ).not.toBe(KIND_ABSENCE_REASONS.MODEL_ABSENT_CONTRADICTED_BY_END_REASON);
      expect(
        Object.values(KIND_ABSENCE_REASONS),
        "the no-source reason must be a literal member of the closed KIND_ABSENCE_REASONS vocabulary",
      ).toContain(kindAbsence.reason);
      expect(
        kindAbsence.reason.toLowerCase(),
        "the reason must name the source-mode family of failure (source reported as absent)",
      ).toMatch(/source/);
    },
    30000,
  );

  it(
    "At the acceptance seam: replaying a hand-authored stream whose SessionStart has source 'clear' and no model (timestamps UTC-Z per PRD-0003 Amendment 1; the stream lives outside the typed fixture manifest, corrupt-line precedent) yields a session that log/show render with the explicit absent kind marker, doctor reports with the new absence reason, and whose absence record survives deleting the ledger and re-ingesting (pure projection, rebuildable from the spool).",
    async () => {
      const { paths, command, opts, runLog } = await setupRepo(tmpRepos);

      const lines = readClearSourceFixtureLines();
      expect(
        lines.length,
        "test setup invariant: clear-source.jsonl must have at least one payload line",
      ).toBeGreaterThan(0);

      const startLine = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(
        startLine.hook_event_name,
        "test setup invariant: clear-source.jsonl's first line must be SessionStart",
      ).toBe("SessionStart");
      expect(
        startLine.source,
        "test setup invariant: clear-source.jsonl's SessionStart must carry source 'clear'",
      ).toBe("clear");
      expect(
        startLine.model,
        "test setup invariant: clear-source.jsonl's SessionStart must carry no model key",
      ).toBeUndefined();

      const sessionId = sessionIdOf(lines[0]!);
      await replayLines(lines, command);

      const logResult = await runLog();
      expect(logResult.exitCode, `log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);

      const shortId = sessionId.slice(0, 8);
      const logLine = logResult.stdout.split("\n").find((l) => l.includes(shortId));
      if (!logLine) throw new Error(`no rendered log line found for session ${sessionId}`);
      expect(
        logLine,
        "log must render the explicit absent marker for a session whose kind degraded to ABSENT",
      ).toContain(ABSENT_MARKER);

      // show must not crash on a session with kind ABSENT (this issue is
      // ingest-fold logic only — render/show.ts is untouched).
      const showResult = await runCli(["show", sessionId], opts);
      expect(
        showResult.exitCode,
        `show did not exit 0 for a session with kind ABSENT; stderr: ${showResult.stderr}`,
      ).toBe(0);

      const ledger = readLedger(paths.ledger);
      const session = ledger.sessions.find((s) => s.session_id === sessionId);
      if (!session) throw new Error("no session row found for the clear-source session after ingest");
      expect(
        session.kind,
        "the hand-authored source:'clear' stream must record kind ABSENT",
      ).toBeNull();

      const absencesBefore = readAbsencesForSession(paths.ledger, sessionId);
      const kindAbsenceBefore = absencesBefore.find((a) => a.facet === "kind");
      if (!kindAbsenceBefore) throw new Error("no kind-facet absence row recorded for the clear-source session");
      expect(
        kindAbsenceBefore.reason,
        "the absence reason must name the observed source value ('clear')",
      ).toContain("clear");

      const doctorResult = await runCli(["doctor"], opts);
      const doctorOutput = `${doctorResult.stdout}\n${doctorResult.stderr}`;
      expect(
        doctorOutput,
        "doctor must report the new kind-absence reason for this session",
      ).toContain(kindAbsenceBefore.reason);
      expect(doctorOutput, "doctor must name the affected session in its report").toContain(sessionId);

      // Absence records survive ledger rebuild — a pure projection,
      // rebuildable from the spool (same pattern as ISS-0020's own drift
      // acceptance test).
      rmSync(paths.ledger, { force: true });
      const rebuildLog = await runLog();
      expect(
        rebuildLog.exitCode,
        `log did not exit 0 after deleting the ledger; stderr: ${rebuildLog.stderr}`,
      ).toBe(0);

      const ledgerAfterRebuild = readLedger(paths.ledger);
      const sessionAfterRebuild = ledgerAfterRebuild.sessions.find((s) => s.session_id === sessionId);
      if (!sessionAfterRebuild) throw new Error("no session row found for the clear-source session after rebuild");
      expect(
        sessionAfterRebuild.kind,
        "ledger rebuild did not reproduce kind ABSENT for the clear-source session",
      ).toBeNull();

      const absencesAfterRebuild = readAbsencesForSession(paths.ledger, sessionId);
      const kindAbsenceAfterRebuild = absencesAfterRebuild.find((a) => a.facet === "kind");
      if (!kindAbsenceAfterRebuild) throw new Error("the kind absence row did not survive ledger rebuild");
      expect(
        kindAbsenceAfterRebuild.reason,
        "the rebuilt kind absence reason changed from the pre-rebuild reason",
      ).toBe(kindAbsenceBefore.reason);
    },
    30000,
  );
});
