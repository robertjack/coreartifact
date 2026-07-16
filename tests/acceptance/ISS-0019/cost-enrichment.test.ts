// ISS-0019 acceptance tests — Cost enrichment: the one transcript-derived
// facet, fail-soft (docs/issues/ISS-0019.md).
//
// Test-harness contract: reuses the acceptance harness's primitives verbatim
// from ../harness/index.js (tmpdir-repo factory, CLI runner, replayLines,
// readLedger) plus the fixtures layer's already-shipped, independent typed
// access: ../../fixtures/loader.js (loadFixtureStream, loadTranscriptPair —
// the envelope oracles are the ground truth every cost/token assertion below
// is checked against) and ../../fixtures/transcriptReplay.js
// (buildSubstitutedTranscript — the one sanctioned substitution: copies the
// paired transcript fixture into a test-owned tmpdir and rewrites
// transcript_path in delivered payloads, never touching a committed file).
//
// src/ingest/enrichment.ts and src/core/priceTable.ts (this issue's [files]
// owns entries) are never imported directly — every assertion below drives
// the built CLI (`log` to ingest, `show` to render) and reads back the
// ledger's already-shipped columns (src/core/ledger.ts's SessionRow, shipped
// by ISS-0013) and the absence-record contract (src/core/absence.ts, shipped
// by ISS-0014) — the public seams the spec names. Both modules are
// independent, already-shipped exports, so they are plain static imports,
// not caught dynamic ones.
//
// The three new recorded fixtures (cost-headless, vitest, background) were
// captured under /private/tmp/.../scratchpad/<name>-repo — a session-hash
// path that is dead on any other machine but is NOT guaranteed dead on the
// exact box that recorded it. Every replayed line's cwd is rebased onto this
// test's own live tmpdir repo (mirrors ISS-0018's rebaseCwdOntoRepo) so
// ingest's repo-root resolution never depends on host machine state.
import { describe, it, expect, afterAll } from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpRepo, runCli, replayLines, readLedger, type TmpRepo } from "../harness/index.js";
import { loadFixtureStream, loadTranscriptPair } from "../../fixtures/loader.js";
import { buildSubstitutedTranscript } from "../../fixtures/transcriptReplay.js";
import { getPaths } from "../../../src/core/paths.js";
import { openLedger, type SessionRow } from "../../../src/core/ledger.js";
import { getSessionAbsences, COST_ABSENCE_REASONS, type AbsenceRow } from "../../../src/core/absence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

function sessionIdOf(fixtureLine: string): string {
  const parsed = JSON.parse(fixtureLine) as { session_id?: unknown };
  if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) {
    throw new Error("test setup invariant: fixture line has no session_id");
  }
  return parsed.session_id;
}

// Rewrites each line's parsed JSON via `fn`, mirroring ISS-0018's own
// rebaseCwdOntoRepo but generalized to whatever fields a given phase needs
// to override (cwd, transcript_path, session_id) — every other recorded
// field stays exactly as-is.
function transformLines(lines: string[], fn: (obj: Record<string, unknown>) => void): string[] {
  return lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    fn(parsed);
    return JSON.stringify(parsed);
  });
}

function rebaseCwd(lines: string[], repoRoot: string): string[] {
  return transformLines(lines, (obj) => {
    obj.cwd = repoRoot;
  });
}

async function ingestViaLog(repo: TmpRepo): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runCli(["log"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
  expect(result.exitCode, `ingest via log did not exit 0; stderr: ${result.stderr}`).toBe(0);
  return result;
}

function findSessionRow(ledgerPath: string, sessionId: string): SessionRow {
  const row = readLedger(ledgerPath).sessions.find((s) => s.session_id === sessionId);
  if (!row) throw new Error(`test setup invariant: no session row found for session ${sessionId}`);
  return row;
}

function readAbsencesFor(ledgerPath: string, sessionId: string): AbsenceRow[] {
  const handle = openLedger(ledgerPath);
  try {
    return getSessionAbsences(handle.db, sessionId);
  } finally {
    handle.close();
  }
}

// Finds a rendered line containing ALL of `tokens` together — mirrors
// ISS-0007/ISS-0008/ISS-0018's own findLineWithAll, needed because a plain
// substring search for the cost figure could in principle collide with
// unrelated numeric output.
function findLineWithAll(output: string, tokens: string[]): string {
  const matches = output.split("\n").filter((line) => tokens.every((t) => line.includes(t)));
  expect(
    matches.length,
    `expected at least one rendered line containing all of ${JSON.stringify(tokens)}, found none. Full output:\n${output}`,
  ).toBeGreaterThanOrEqual(1);
  return matches[0]!;
}

// Rewrites every assistant line's message.usage to be entirely absent — "a
// hand-authored shape outside the pinned parse" (spec's own words for this
// exact drift case) — on the tmpdir COPY only, never a committed fixture.
function driftTranscriptByRemovingUsage(transcriptPath: string): void {
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const drifted = lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type === "assistant") {
      const message = parsed.message as Record<string, unknown> | undefined;
      if (message) delete message.usage;
    }
    return JSON.stringify(parsed);
  });
  writeFileSync(transcriptPath, drifted.join("\n") + "\n");
}

// Rewrites every assistant line's message.model to an id outside the pinned
// price table — on the tmpdir COPY only.
function rewriteTranscriptModel(transcriptPath: string, model: string): void {
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const rewritten = lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type === "assistant") {
      const message = parsed.message as Record<string, unknown> | undefined;
      if (message) message.model = model;
    }
    return JSON.stringify(parsed);
  });
  writeFileSync(transcriptPath, rewritten.join("\n") + "\n");
}

function listFilesRecursively(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursively(full));
    else out.push(full);
  }
  return out;
}

describe("ISS-0019 cost enrichment: the one transcript-derived facet, fail-soft", () => {
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

  it(
    "R5 Cost enrichment, fail-soft. After ingest of a stream whose paired transcript fixture is present at the session's transcript path: the session carries cost and token counts matching the fixture's known values, rendered with a derived marker in log and show. Transcripts are read in place, never copied (law).",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const init = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];
      const dataDir = dirname(paths.spool);

      const pair = loadTranscriptPair("cost-headless");
      if (!pair.oracle) throw new Error("test setup invariant: cost-headless must carry an envelope oracle");
      const oracle = pair.oracle;
      const sessionId = sessionIdOf(loadFixtureStream("cost-headless")[0]!);

      const workDir = makeScratchDir("coreartifact-iss19-r5-");
      const substituted = buildSubstitutedTranscript("cost-headless", workDir);
      const rebased = rebaseCwd(substituted.lines, repo.root);

      const transcriptBytesBeforeIngest = readFileSync(substituted.transcriptPath);

      await replayLines(rebased, command);
      await ingestViaLog(repo);

      // --- ledger columns match the oracle exactly. ---
      const sessionRow = findSessionRow(paths.ledger, sessionId);
      expect(sessionRow.tokens_input, "tokens_input did not match the envelope oracle").toBe(
        oracle.usage.input_tokens,
      );
      expect(sessionRow.tokens_output, "tokens_output did not match the envelope oracle").toBe(
        oracle.usage.output_tokens,
      );
      expect(sessionRow.tokens_cache_read, "tokens_cache_read did not match the envelope oracle").toBe(
        oracle.usage.cache_read_input_tokens,
      );
      expect(
        sessionRow.tokens_cache_creation,
        "tokens_cache_creation did not match the envelope oracle",
      ).toBe(oracle.usage.cache_creation_input_tokens);
      expect(sessionRow.cost_usd, "cost_usd did not match the envelope oracle's total_cost_usd").toBe(
        oracle.total_cost_usd,
      );

      // --- rendered with a derived marker in both log and show. ---
      const logResult = await runCli(["log"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(logResult.exitCode, `log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);
      const logOutput = `${logResult.stdout}\n${logResult.stderr}`;
      const logCostLine = findLineWithAll(logOutput, [String(oracle.total_cost_usd)]);
      expect(
        logCostLine,
        "log's rendered cost figure was not accompanied by a derived marker distinguishing it from spool-borne facets",
      ).toMatch(/derived/i);

      const showResult = await runCli(["show", sessionId], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(showResult.exitCode, `show did not exit 0; stderr: ${showResult.stderr}`).toBe(0);
      const showOutput = `${showResult.stdout}\n${showResult.stderr}`;
      const showCostLine = findLineWithAll(showOutput, [String(oracle.total_cost_usd)]);
      expect(
        showCostLine,
        "show's rendered cost figure was not accompanied by a derived marker distinguishing it from spool-borne facets",
      ).toMatch(/derived/i);

      // --- transcripts are read in place, never copied (law). ---
      expect(
        readFileSync(substituted.transcriptPath).equals(transcriptBytesBeforeIngest),
        "ingest mutated the transcript file at its recorded path — it must be opened read-only",
      ).toBe(true);
      const transcriptBytes = readFileSync(substituted.transcriptPath);
      for (const file of listFilesRecursively(dataDir)) {
        expect(
          readFileSync(file).equals(transcriptBytes),
          `found a byte-identical copy of the transcript under the repo's data directory (${file}) — the transcript must be read in place at its stored path, never copied`,
        ).toBe(false);
      }
    },
    30000,
  );

  it(
    "R6 Cost degradation is explicit. A missing transcript file → cost ABSENT with reason \"transcript unavailable\". A hand-authored drifted transcript (shape outside the pinned parse) → cost ABSENT with a reason naming the mismatch — never zero, never estimated — and ingest completes normally. Deleting the ledger and re-ingesting after the transcript appears retroactively regains the facet (drift is recoverable, not lossy).",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const init = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];
      const costHeadlessPair = loadTranscriptPair("cost-headless");

      // --- Phase 1: missing transcript file. A guaranteed-nonexistent
      // path under a fresh scratch dir (never created), rather than trusting
      // the recorded fixture path to be absent on whatever machine runs
      // this suite. ---
      const missingScratchDir = makeScratchDir("coreartifact-iss19-r6-missing-");
      const missingTranscriptPath = join(missingScratchDir, "nonexistent.transcript.jsonl");
      const missingSessionId = "iss19-r6-missing-transcript-session";
      expect(existsSync(missingTranscriptPath), "test setup invariant: the missing-transcript path must not exist").toBe(
        false,
      );

      const missingLines = transformLines(loadFixtureStream("cost-headless"), (obj) => {
        obj.cwd = repo.root;
        obj.session_id = missingSessionId;
        obj.transcript_path = missingTranscriptPath;
      });
      await replayLines(missingLines, command);
      const missingLog = await ingestViaLog(repo);
      expect(missingLog.exitCode, "ingest did not complete normally when the transcript file was missing").toBe(0);

      const missingRow = findSessionRow(paths.ledger, missingSessionId);
      expect(missingRow.cost_usd, "cost_usd was not ABSENT (NULL) for a missing transcript").toBeNull();
      expect(missingRow.cost_usd, "cost_usd degraded to zero instead of ABSENT for a missing transcript").not.toBe(0);
      expect(missingRow.tokens_input, "tokens_input was not ABSENT (NULL) for a missing transcript").toBeNull();

      const missingAbsences = readAbsencesFor(paths.ledger, missingSessionId);
      const missingCostAbsence = missingAbsences.find((a) => a.facet === "cost");
      expect(missingCostAbsence, "no absence row was recorded for facet 'cost' on a missing transcript").toBeDefined();
      expect(missingCostAbsence!.reason).toBe(COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);

      // --- Phase 2: hand-authored drifted transcript (shape outside the
      // pinned parse) — substitute normally, then overwrite the tmpdir COPY
      // (never the committed fixture) to strip message.usage from every
      // assistant line. ---
      const driftedScratchDir = makeScratchDir("coreartifact-iss19-r6-drifted-");
      const driftedSubstituted = buildSubstitutedTranscript("cost-headless", driftedScratchDir);
      driftTranscriptByRemovingUsage(driftedSubstituted.transcriptPath);
      const driftedSessionId = "iss19-r6-drifted-transcript-session";
      const driftedLines = transformLines(driftedSubstituted.lines, (obj) => {
        obj.cwd = repo.root;
        obj.session_id = driftedSessionId;
      });
      await replayLines(driftedLines, command);
      const driftedLog = await ingestViaLog(repo);
      expect(driftedLog.exitCode, "ingest did not complete normally over a drifted transcript").toBe(0);

      const driftedRow = findSessionRow(paths.ledger, driftedSessionId);
      expect(driftedRow.cost_usd, "cost_usd was not ABSENT (NULL) for a drifted transcript").toBeNull();
      expect(driftedRow.cost_usd, "cost_usd degraded to zero instead of ABSENT for a drifted transcript").not.toBe(0);
      expect(driftedRow.tokens_input, "tokens_input was not ABSENT (NULL) for a drifted transcript").toBeNull();

      const driftedAbsences = readAbsencesFor(paths.ledger, driftedSessionId);
      const driftedCostAbsence = driftedAbsences.find((a) => a.facet === "cost");
      expect(driftedCostAbsence, "no absence row was recorded for facet 'cost' on a drifted transcript").toBeDefined();
      expect(driftedCostAbsence!.reason).toBe(COST_ABSENCE_REASONS.TRANSCRIPT_SHAPE_UNRECOGNIZED);

      // --- Phase 3: recovery. Place a real transcript at the path phase 1
      // recorded as missing, delete the ledger, re-ingest — the facet must
      // come back, and the absence row must be gone (drift is recoverable,
      // not lossy). ---
      const committedTranscriptPath = join(REPO_ROOT, costHeadlessPair.transcript);
      copyFileSync(committedTranscriptPath, missingTranscriptPath);
      expect(existsSync(missingTranscriptPath), "test setup invariant: the transcript now exists at the recorded path").toBe(
        true,
      );

      rmSync(paths.ledger, { force: true });
      const recoveredLog = await ingestViaLog(repo);
      expect(recoveredLog.exitCode, "ingest did not complete normally after the ledger was deleted and rebuilt").toBe(
        0,
      );

      const recoveredRow = findSessionRow(paths.ledger, missingSessionId);
      expect(recoveredRow.cost_usd, "cost_usd did not retroactively regain after the transcript appeared").not.toBeNull();
      expect(recoveredRow.tokens_input, "tokens_input did not retroactively regain after the transcript appeared").not.toBeNull();

      const recoveredAbsences = readAbsencesFor(paths.ledger, missingSessionId);
      expect(
        recoveredAbsences.find((a) => a.facet === "cost"),
        "the cost absence row was not cleared after the facet recovered",
      ).toBeUndefined();
    },
    60000,
  );

  it(
    "Token counts are parsed by deduplicating assistant lines on requestId, taking one usage object per request and summing across requests; over the cost-headless pair this reproduces the envelope oracle exactly — 12 input, 805 output and 166807 cache-read tokens across 6 distinct requests — and a naive per-line summer would not.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const init = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];

      const pair = loadTranscriptPair("cost-headless");
      if (!pair.oracle) throw new Error("test setup invariant: cost-headless must carry an envelope oracle");
      const oracle = pair.oracle;
      expect(oracle.distinct_requests, "test setup invariant: the oracle must name 6 distinct requests").toBe(6);
      expect(oracle.usage.input_tokens).toBe(12);
      expect(oracle.usage.output_tokens).toBe(805);
      expect(oracle.usage.cache_read_input_tokens).toBe(166807);

      const sessionId = sessionIdOf(loadFixtureStream("cost-headless")[0]!);

      const workDir = makeScratchDir("coreartifact-iss19-dedup-");
      const substituted = buildSubstitutedTranscript("cost-headless", workDir);
      const rebased = rebaseCwd(substituted.lines, repo.root);
      await replayLines(rebased, command);
      await ingestViaLog(repo);

      // Independent oracle for "a naive per-line summer would not [reproduce
      // it]": compute the naive (non-deduplicated) sum directly from the
      // committed transcript fixture here, never from the module under
      // test, and confirm it disagrees with the pinned oracle — proving
      // this scenario actually requires the dedup rule to pass.
      const committedTranscriptPath = join(REPO_ROOT, pair.transcript);
      const transcriptLines = readFileSync(committedTranscriptPath, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const assistantLines = transcriptLines.filter((l) => l.type === "assistant");
      const naiveInputSum = assistantLines.reduce(
        (sum, l) => sum + ((l.message as Record<string, unknown>).usage as Record<string, number>).input_tokens,
        0,
      );
      expect(
        naiveInputSum,
        "test setup invariant: the recovered fixture's assistant lines must repeat usage under shared requestIds so a naive per-line sum over-counts",
      ).not.toBe(oracle.usage.input_tokens);

      const sessionRow = findSessionRow(paths.ledger, sessionId);
      expect(
        sessionRow.tokens_input,
        `tokens_input must equal the deduplicated oracle (${oracle.usage.input_tokens}), not the naive per-line sum (${naiveInputSum})`,
      ).toBe(oracle.usage.input_tokens);
      expect(sessionRow.tokens_output).toBe(oracle.usage.output_tokens);
      expect(sessionRow.tokens_cache_read).toBe(oracle.usage.cache_read_input_tokens);
    },
    30000,
  );

  it(
    "cost_usd is computed from the pinned per-model price table and reproduces each committed envelope oracle's total_cost_usd to the digit: 0.555957 for cost-headless, 0.438619 for vitest and 0.674005 for background.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const init = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];

      const scenarios = ["cost-headless", "vitest", "background"] as const;
      const expectedBySession: Record<string, number> = {};

      for (const scenario of scenarios) {
        const pair = loadTranscriptPair(scenario);
        if (!pair.oracle) throw new Error(`test setup invariant: ${scenario} must carry an envelope oracle`);
        const sessionId = sessionIdOf(loadFixtureStream(scenario)[0]!);
        expectedBySession[sessionId] = pair.oracle.total_cost_usd;

        const workDir = makeScratchDir(`coreartifact-iss19-price-${scenario}-`);
        const substituted = buildSubstitutedTranscript(scenario, workDir);
        const rebased = rebaseCwd(substituted.lines, repo.root);
        await replayLines(rebased, command);
      }

      await ingestViaLog(repo);

      expect(expectedBySession, "test setup invariant: three distinct sessions were expected").toEqual({
        [sessionIdOf(loadFixtureStream("cost-headless")[0]!)]: 0.555957,
        [sessionIdOf(loadFixtureStream("vitest")[0]!)]: 0.438619,
        [sessionIdOf(loadFixtureStream("background")[0]!)]: 0.674005,
      });

      for (const [sessionId, expectedCost] of Object.entries(expectedBySession)) {
        const row = findSessionRow(paths.ledger, sessionId);
        expect(row.cost_usd, `cost_usd for session ${sessionId} did not reproduce the oracle to the digit`).toBe(
          expectedCost,
        );
      }
    },
    60000,
  );

  it(
    "A transcript whose model is not in the pinned price table yields tokens present and cost ABSENT with an absence reason naming the unpinned model — tokens and cost degrade independently, and a price-table fix plus delete-and-reingest retroactively regains cost.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const init = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];

      const pair = loadTranscriptPair("cost-headless");
      if (!pair.oracle) throw new Error("test setup invariant: cost-headless must carry an envelope oracle");
      const oracle = pair.oracle;

      // claude-sonnet-5 is named in this issue's own spec as deliberately
      // unpinned this campaign (an intro-pricing window) — not a guessed id.
      const unpinnedModel = "claude-sonnet-5";
      const sessionId = "iss19-unpinned-model-session";

      const workDir = makeScratchDir("coreartifact-iss19-unpinned-");
      const substituted = buildSubstitutedTranscript("cost-headless", workDir);
      rewriteTranscriptModel(substituted.transcriptPath, unpinnedModel);
      const lines = transformLines(substituted.lines, (obj) => {
        obj.cwd = repo.root;
        obj.session_id = sessionId;
      });
      await replayLines(lines, command);
      await ingestViaLog(repo);

      const row = findSessionRow(paths.ledger, sessionId);
      // Tokens are parsed independently of the model/price table — they must
      // stay present even though this model has no pinned rate.
      expect(row.tokens_input, "tokens_input must stay present for an unpinned model").toBe(oracle.usage.input_tokens);
      expect(row.tokens_output, "tokens_output must stay present for an unpinned model").toBe(
        oracle.usage.output_tokens,
      );
      expect(row.tokens_cache_read, "tokens_cache_read must stay present for an unpinned model").toBe(
        oracle.usage.cache_read_input_tokens,
      );
      expect(row.model, "the unpinned model id must still be recorded (readable transcript)").toBe(unpinnedModel);

      expect(row.cost_usd, "cost_usd was not ABSENT (NULL) for an unpinned model").toBeNull();
      expect(row.cost_usd, "cost_usd degraded to zero instead of ABSENT for an unpinned model").not.toBe(0);

      const absences = readAbsencesFor(paths.ledger, sessionId);
      const costAbsence = absences.find((a) => a.facet === "cost");
      expect(costAbsence, "no absence row was recorded for facet 'cost' on an unpinned model").toBeDefined();
      expect(costAbsence!.reason).toBe(COST_ABSENCE_REASONS.modelUnpinned(unpinnedModel));
    },
    30000,
  );

  it(
    "Enrichment records the transcript's top-level version field on the session as the per-session recorded Claude Code version when the transcript is readable, and leaves it ABSENT otherwise.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const init = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];

      const pair = loadTranscriptPair("cost-headless");
      const readableSessionId = sessionIdOf(loadFixtureStream("cost-headless")[0]!);

      const workDir = makeScratchDir("coreartifact-iss19-ccversion-readable-");
      const substituted = buildSubstitutedTranscript("cost-headless", workDir);
      const rebased = rebaseCwd(substituted.lines, repo.root);
      await replayLines(rebased, command);

      // Unreadable transcript: a guaranteed-nonexistent path, distinct
      // session — mirrors the R6 missing-transcript setup.
      const missingScratchDir = makeScratchDir("coreartifact-iss19-ccversion-missing-");
      const missingTranscriptPath = join(missingScratchDir, "nonexistent.transcript.jsonl");
      const unreadableSessionId = "iss19-ccversion-unreadable-session";
      const unreadableLines = transformLines(loadFixtureStream("cost-headless"), (obj) => {
        obj.cwd = repo.root;
        obj.session_id = unreadableSessionId;
        obj.transcript_path = missingTranscriptPath;
      });
      await replayLines(unreadableLines, command);

      await ingestViaLog(repo);

      const readableRow = findSessionRow(paths.ledger, readableSessionId);
      expect(
        readableRow.cc_version,
        "cc_version did not record the transcript's top-level version field when the transcript was readable",
      ).toBe(pair.claudeCodeVersion);

      const unreadableRow = findSessionRow(paths.ledger, unreadableSessionId);
      expect(
        unreadableRow.cc_version,
        "cc_version was not ABSENT (NULL) when the transcript could not be read",
      ).toBeNull();
    },
    30000,
  );
});
