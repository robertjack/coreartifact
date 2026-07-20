// The sanctioned substitution — a fixtures-owned transcript-replay wrapper
// (spec R13 "Fixtures wired for the loop"). Given a transcript pair and a
// test tmpdir, copies the paired transcript fixture into the tmpdir,
// rewrites transcript_path in each stream payload line to that copy (every
// other payload byte unchanged), and delivers the substituted lines to a
// caller-supplied hook command. Committed fixture files are only ever read,
// never rewritten in place.
//
// This module intentionally does NOT route delivery through the acceptance
// harness's own replayLines (ISS-0033): that primitive unconditionally pins
// `cwd` to a repo root, but this wrapper's own contract (pinned by
// tests/acceptance/ISS-0016/transcript-replay-wrapper.test.ts) is narrower
// and predates it — substitute transcript_path ONLY, leave every other
// payload byte (including cwd) exactly as recorded. The two contracts are
// orthogonal, not layered: a caller that also needs cwd pinned combines
// buildSubstitutedTranscript's output with the harness's replayLines
// directly (transcriptPathOverride), rather than through this wrapper.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadFixtureStream, loadManifest, loadTranscriptPair, type ScenarioName } from "./loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Scenario discovery for callers that only know this module (never the
// loader) — delegates to the loader's own typed manifest, never a second
// hand-rolled scenario list.
export function listScenarios(): string[] {
  return loadManifest().streams.map((entry) => entry.scenario);
}

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

export interface ReplayInvocation {
  stdinBytes: Uint8Array;
  exitCode: number;
}

export interface SubstitutedReplayResult {
  invocations: ReplayInvocation[];
  transcriptPath: string;
  lines: string[];
}

function runOneInvocation(command: string[], payload: string): Promise<ReplayInvocation> {
  const [cmd, ...args] = command;
  if (!cmd) throw new Error("replaySubstitutedTranscript: empty command");
  const stdinBytes = Buffer.from(payload, "utf8");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ stdinBytes, exitCode: code ?? -1 });
    });
    child.stdin.write(stdinBytes);
    child.stdin.end();
  });
}

/**
 * Build the substituted lines for a transcript pair and deliver them to a
 * hook command directly (one invocation per line, in order) — mirroring
 * what Claude Code does on a real machine. Every payload byte other than
 * transcript_path reaches the command exactly as recorded.
 */
export async function replaySubstitutedTranscript(
  scenario: string,
  workDir: string,
  command: string[],
  lineCount?: number,
): Promise<SubstitutedReplayResult> {
  const { lines, transcriptPath } = buildSubstitutedTranscript(scenario, workDir, lineCount);
  const invocations: ReplayInvocation[] = [];
  for (const line of lines) {
    invocations.push(await runOneInvocation(command, line));
  }
  return { invocations, transcriptPath, lines };
}
