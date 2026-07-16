// ISS-0020 acceptance tests — The drift detector: ABSENT always names its why.
//
// Test-harness contract: reuses the acceptance harness's primitives verbatim
// from ../harness/index.js (tmpdir-repo factory, CLI runner, fixture
// replayer's replayLines primitive for explicit in-memory-modified streams,
// readLedger for `kind`). The absence-record contract module
// (src/core/absence.ts) and the ledger module (src/core/ledger.ts) both
// already shipped (ISS-0013/ISS-0014) — these are plain static imports, not
// caught dynamic ones, since only the drift detector's WIRING inside ingest
// is new; every assertion below drives that wiring only through the built
// CLI (`log`) and reads back through the absence contract's own read API
// (getSessionAbsences/getAllAbsences), never raw SQLite, never a harness
// edit.
//
// The drift stream is derived in-memory, never committed: the interactive
// fixture's SessionStart, loaded through the typed loader, with its `model`
// key deleted before replay. Its SessionEnd (`reason: "prompt_input_exit"`)
// is untouched and is what supplies the contradiction. Verified against the
// raw fixture bytes (2026-07-16): interactive.jsonl's SessionStart carries
// `model: "claude-fable-5"` and its SessionEnd carries
// `reason: "prompt_input_exit"`; headless.jsonl's SessionEnd carries
// `reason: "other"` and its SessionStart carries no `model` key at all.
import { describe, it, expect, afterAll } from "vitest";
import { rmSync } from "node:fs";
// @ts-ignore -- node:sqlite has no ambient types available in this sandbox (see src/core/ledger.ts / harness/readers.ts)
import { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";
import { createTmpRepo, runCli, replayFixtures, replayLines, readLedger, type TmpRepo } from "../harness/index.js";
import { loadFixtureStream } from "../../fixtures/loader.js";
import { getPaths } from "../../../src/core/paths.js";
import { getSessionAbsences, KIND_ABSENCE_REASONS, type AbsenceRow } from "../../../src/core/absence.js";

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

/**
 * The drift stream: the interactive scenario's lines with `model` deleted
 * from the SessionStart payload in memory. Never committed — corrupt-line.jsonl
 * stays the corpus's only hand-authored file (spec's Test-harness contract).
 */
function buildDriftStream(): string[] {
  const lines = loadFixtureStream("interactive");
  const [startLine, ...rest] = lines;
  if (!startLine) throw new Error("test setup invariant: interactive fixture has no SessionStart line to strip");
  const start = JSON.parse(startLine) as Record<string, unknown>;
  expect(
    typeof start.model,
    "test setup invariant: the interactive fixture's SessionStart must carry a model key before stripping",
  ).toBe("string");
  delete start.model;
  return [JSON.stringify(start), ...rest];
}

async function setupRepo(tmpRepos: TmpRepo[]): Promise<{
  repo: TmpRepo;
  paths: ReturnType<typeof getPaths>;
  command: string[];
  runLog: () => ReturnType<typeof runCli>;
}> {
  const repo = await createTmpRepo();
  tmpRepos.push(repo);
  const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
  expect(initResult.exitCode, `test setup invariant: init did not exit 0; stderr: ${initResult.stderr}`).toBe(0);

  const paths = getPaths(repo.root);
  const command = ["node", paths.hookArtifact, repo.root];
  const runLog = () => runCli(["log"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });

  return { repo, paths, command, runLog };
}

describe("ISS-0020 drift detector: ABSENT always names its why", () => {
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it(
    "R7 Drift detector. Whenever ingest degrades a facet to ABSENT, it records an absence reason naming the facet and the missing/mismatched source (the fragile-dependency register is the enumeration). Replaying a hand-authored stream with model stripped from SessionStart yields kind ABSENT plus an absence record naming the missing key. Absence records survive ledger rebuild (derived from the spool).",
    async () => {
      const { paths, command, runLog } = await setupRepo(tmpRepos);

      const driftLines = buildDriftStream();
      const driftSessionId = sessionIdOf(driftLines[0]!);
      await replayLines(driftLines, command);

      const logResult = await runLog();
      expect(logResult.exitCode, `log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);

      const ledgerAfterFirst = readLedger(paths.ledger);
      const driftSession = ledgerAfterFirst.sessions.find((s) => s.session_id === driftSessionId);
      if (!driftSession) throw new Error("no session row found for the drift session after ingest");
      expect(driftSession.kind, "a model-stripped, end-reason-contradicted session did not record kind ABSENT").toBeNull();

      const absencesAfterFirst = readAbsencesForSession(paths.ledger, driftSessionId);
      const kindAbsenceAfterFirst = absencesAfterFirst.find((a) => a.facet === "kind");
      if (!kindAbsenceAfterFirst) throw new Error("no kind-facet absence row recorded for the drift session");
      expect(
        kindAbsenceAfterFirst.reason,
        "the kind absence reason did not name the missing key (model)",
      ).toContain("model");

      // Absence records survive ledger rebuild — derived purely from the spool.
      rmSync(paths.ledger, { force: true });
      const rebuildLog = await runLog();
      expect(rebuildLog.exitCode, `log did not exit 0 after deleting the ledger; stderr: ${rebuildLog.stderr}`).toBe(0);

      const ledgerAfterRebuild = readLedger(paths.ledger);
      const driftSessionAfterRebuild = ledgerAfterRebuild.sessions.find((s) => s.session_id === driftSessionId);
      if (!driftSessionAfterRebuild) throw new Error("no session row found for the drift session after rebuild");
      expect(driftSessionAfterRebuild.kind, "rebuild did not reproduce kind ABSENT for the drift session").toBeNull();

      const absencesAfterRebuild = readAbsencesForSession(paths.ledger, driftSessionId);
      const kindAbsenceAfterRebuild = absencesAfterRebuild.find((a) => a.facet === "kind");
      if (!kindAbsenceAfterRebuild) throw new Error("the kind absence row did not survive ledger rebuild");
      expect(
        kindAbsenceAfterRebuild.reason,
        "the rebuilt kind absence reason changed from the pre-rebuild reason",
      ).toBe(kindAbsenceAfterFirst.reason);
    },
    30000,
  );

  it(
    "The drift fixture is the interactive stream with model stripped from its SessionStart: its surviving prompt_input_exit end-reason contradicts a headless classification, so the session's kind records ABSENT with the absence reason model absent, contradicted by end-reason — while the unmodified headless stream, which also lacks model, still classifies headless with no absence row (real headless sessions never regress).",
    async () => {
      const { paths, command, runLog } = await setupRepo(tmpRepos);

      // Independent-oracle sanity check on the raw fixture bytes (verified by
      // execution 2026-07-16): the interactive SessionEnd's surviving reason
      // really is prompt_input_exit, the contradiction this rule rests on.
      const driftLines = buildDriftStream();
      const endEvent = driftLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((e) => e.hook_event_name === "SessionEnd");
      if (!endEvent) throw new Error("test setup invariant: interactive fixture has no SessionEnd line");
      expect(
        endEvent.reason,
        "test setup invariant: the interactive fixture's SessionEnd reason must be prompt_input_exit",
      ).toBe("prompt_input_exit");

      const driftSessionId = sessionIdOf(driftLines[0]!);
      await replayLines(driftLines, command);

      // Non-regression control: the UNMODIFIED headless stream also lacks
      // `model` on its SessionStart, but its end-reason ("other") is
      // consistent, so it must still classify headless with zero absence
      // rows — real headless sessions never regress.
      const headlessLines = loadFixtureStream("headless");
      const headlessStart = JSON.parse(headlessLines[0]!) as Record<string, unknown>;
      expect(
        headlessStart.model,
        "test setup invariant: the headless fixture's SessionStart must not carry a model key",
      ).toBeUndefined();
      const headlessSessionId = sessionIdOf(headlessLines[0]!);
      await replayFixtures("headless", command);

      const logResult = await runLog();
      expect(logResult.exitCode, `log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);

      const ledger = readLedger(paths.ledger);

      const driftSession = ledger.sessions.find((s) => s.session_id === driftSessionId);
      if (!driftSession) throw new Error("no session row found for the drift session after ingest");
      expect(driftSession.kind, "the contradicted drift session did not record kind ABSENT").toBeNull();

      const driftAbsences = readAbsencesForSession(paths.ledger, driftSessionId);
      const driftKindAbsence = driftAbsences.find((a) => a.facet === "kind");
      if (!driftKindAbsence) throw new Error("no kind-facet absence row recorded for the drift session");
      expect(
        driftKindAbsence.reason,
        "the drift session's absence reason did not match the exact enumerated string",
      ).toBe(KIND_ABSENCE_REASONS.MODEL_ABSENT_CONTRADICTED_BY_END_REASON);
      expect(driftKindAbsence.reason).toBe("model absent, contradicted by end-reason");

      const headlessSession = ledger.sessions.find((s) => s.session_id === headlessSessionId);
      if (!headlessSession) throw new Error("no session row found for the headless session after ingest");
      expect(
        headlessSession.kind,
        "the unmodified headless stream (also lacking model, but end-reason-consistent) regressed away from headless",
      ).toBe("headless");

      const headlessAbsences = readAbsencesForSession(paths.ledger, headlessSessionId);
      expect(
        headlessAbsences.filter((a) => a.facet === "kind"),
        "a real headless session recorded a kind absence row — real headless sessions must never regress",
      ).toHaveLength(0);
    },
    30000,
  );

  it(
    "A stream with no SessionStart line at all yields kind ABSENT with the absence reason no SessionStart captured.",
    async () => {
      const { paths, command, runLog } = await setupRepo(tmpRepos);

      // The no-SessionStart case: a loaded stream with its SessionStart line
      // dropped in memory (never a hand-authored line).
      const linesWithoutStart = loadFixtureStream("headless").slice(1);
      const secondLine = linesWithoutStart[0];
      if (!secondLine) throw new Error("test setup invariant: headless fixture has too few lines to drop SessionStart from");
      const noStartSessionId = sessionIdOf(secondLine);

      await replayLines(linesWithoutStart, command);

      const logResult = await runLog();
      expect(logResult.exitCode, `log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);

      const ledger = readLedger(paths.ledger);
      const noStartSession = ledger.sessions.find((s) => s.session_id === noStartSessionId);
      if (!noStartSession) throw new Error("no session row found for the no-SessionStart session after ingest");
      expect(noStartSession.kind, "a session with no captured SessionStart line did not record kind ABSENT").toBeNull();

      const absences = readAbsencesForSession(paths.ledger, noStartSessionId);
      const kindAbsence = absences.find((a) => a.facet === "kind");
      if (!kindAbsence) throw new Error("no kind-facet absence row recorded for the no-SessionStart session");
      expect(
        kindAbsence.reason,
        "the no-SessionStart absence reason did not match the exact enumerated string",
      ).toBe(KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED);
      expect(kindAbsence.reason).toBe("no SessionStart captured");
    },
    30000,
  );
});
