// The sanctioned substitution — a fixtures-owned transcript-replay wrapper
// (spec R13 "Fixtures wired for the loop"). Given a transcript pair and a
// test tmpdir, copies the paired transcript fixture into the tmpdir,
// rewrites transcript_path in each stream payload line to that copy (every
// other payload byte unchanged), and delivers the substituted lines through
// the acceptance harness's existing explicit-lines replay primitive
// (replayLines, imported — the harness itself is never edited by this
// module). Committed fixture files are only ever read, never rewritten in
// place.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtureStream, loadTranscriptPair, type ScenarioName } from "./loader.js";
import { replayLines, type ReplayResult } from "../acceptance/harness/fixtureReplayer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export interface SubstitutedTranscript {
  /** Substituted payload lines (transcript_path rewritten to the tmpdir copy). */
  lines: string[];
  /** Path to the tmpdir copy of the paired transcript fixture. */
  transcriptPath: string;
}

/**
 * Build the substituted stream lines and tmpdir transcript copy for a
 * transcript pair, without delivering them anywhere. Callers that need a
 * truncated prefix (e.g. the background-outcome slice, which replays only
 * the lines up through a SIGKILL point) pass `lineCount`.
 */
export function buildSubstitutedTranscript(scenario: string, workDir: string, lineCount?: number): SubstitutedTranscript {
  const pair = loadTranscriptPair(scenario);
  const streamLines = loadFixtureStream(scenario as ScenarioName);
  const selectedLines = lineCount === undefined ? streamLines : streamLines.slice(0, lineCount);

  const srcTranscriptPath = path.join(REPO_ROOT, pair.transcript);
  const destTranscriptPath = path.join(workDir, path.basename(srcTranscriptPath));
  fs.copyFileSync(srcTranscriptPath, destTranscriptPath);

  const lines = selectedLines.map((line) => {
    const payload = JSON.parse(line) as Record<string, unknown>;
    payload.transcript_path = destTranscriptPath;
    return JSON.stringify(payload);
  });

  return { lines, transcriptPath: destTranscriptPath };
}

export interface SubstitutedReplayResult extends ReplayResult {
  transcriptPath: string;
  lines: string[];
}

/**
 * Build the substituted lines for a transcript pair and deliver them to a
 * hook command through the harness's explicit-lines replay primitive
 * (replayLines) — mirroring what Claude Code does on a real machine (one
 * hook invocation per line, transcript_path pointing at the session's own
 * transcript file).
 */
export async function replaySubstitutedTranscript(
  scenario: string,
  workDir: string,
  command: string[],
  lineCount?: number,
): Promise<SubstitutedReplayResult> {
  const { lines, transcriptPath } = buildSubstitutedTranscript(scenario, workDir, lineCount);
  const result = await replayLines(lines, command);
  return { ...result, transcriptPath, lines };
}
