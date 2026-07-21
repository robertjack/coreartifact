// The acceptance harness — one seam, four primitives, exported from one
// place (spec-v1.md "The acceptance harness", ISS-0003). Every later issue's
// Test-harness contract copies this directory verbatim; never re-derive it,
// never fork it.
//
// ISS-0033 adds two thin ingest/read helpers (`ingest`, `getSession`) that
// operate directly on a pin target, independent of the CLI/registry: they
// let a hermetic-replay proof ingest and inspect a session without an
// `init`/registry round trip, using the already-shipped ingest and ledger
// modules directly.
export { createTmpRepo, type TmpRepo } from "./tmpRepo.js";
export { runCli, type RunCliOptions, type RunCliResult } from "./cliRunner.js";
export {
  replayFixtures,
  replayFixturesParallel,
  replayLines,
  replaySubstitutedTranscript,
  type ReplayInvocation,
  type ReplayResult,
  type ReplayOptions,
  type ParallelReplayRequest,
} from "./fixtureReplayer.js";
export { addWorktree, type Worktree } from "./worktree.js";
export { readSpool, readLedger, type LedgerSnapshot } from "./readers.js";
export { gitEnv } from "./gitEnv.js";
export { baseHermeticEnv } from "./env.js";

import { getPaths } from "../../../src/core/paths.js";
import { ingest as runIngest, type IngestReport } from "../../../src/ingest/index.js";
import { readLedger as readLedgerSnapshot } from "./readers.js";
import type { SessionRow } from "../../../src/core/ledger.js";

/** Ingests a pin target's spool directly (no CLI subprocess, no registry). */
export async function ingest(repoRoot: string): Promise<IngestReport> {
  return runIngest(repoRoot);
}

export type HarnessSessionRow = Omit<SessionRow, "model"> & { model: string | null | "ABSENT" };

/**
 * Reads back one session row from a pin target's ledger, translating a NULL
 * (ABSENT) transcript-derived model into the literal string "ABSENT" —
 * proving enrichment from a machine-leftover transcript is unexpressible
 * through the harness, not merely absent-by-accident.
 */
export function getSession(repoRoot: string, sessionId: string): HarnessSessionRow | undefined {
  const paths = getPaths(repoRoot);
  const ledger = readLedgerSnapshot(paths.ledger);
  const row = ledger.sessions.find((s) => s.session_id === sessionId);
  if (!row) return undefined;
  return { ...row, model: row.model === null ? "ABSENT" : row.model };
}

// Strips Node's own runtime diagnostic lines from captured CLI output before
// asserting on it — on the engines floor (22.x) `node:sqlite` emits
// "(node:<pid>) ExperimentalWarning: ..." plus a trace-warnings hint to
// stderr, which is runtime framing, not product output. Found by CI run #1
// (2026-07-21, macos-15 @ node 22.13 — the first execution ever at the
// floor): the pid varies per process (breaking byte-equality comparisons)
// and "Warning" matches /warn/i (breaking negative warning assertions).
export function stripNodeDiagnostics(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\(node:\d+\) /.test(line) && !line.startsWith("(Use `node --trace-warnings"))
    .join("\n");
}
