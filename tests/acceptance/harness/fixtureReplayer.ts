// The fixture replayer — primitive 3 of the acceptance harness (spec-v1.md
// "The acceptance harness", ISS-0003). Loads a fixture stream by scenario
// name through the fixtures issue's loader (never a raw path) and pipes each
// payload line into a hook command on stdin, one process invocation per
// line, in order.
//
// Hermetic replay by construction (ISS-0033, the PRD-0003 retro's process
// change): every replay call takes a REQUIRED pin target — the caller's
// tmp-repo root. Every parseable payload line is delivered with `cwd`
// rewritten to the pin target and `transcript_path` rewritten to a
// guaranteed-nonexistent sentinel inside the pin target, unless the caller
// supplies `transcriptPathOverride` (the sanctioned-substitution case, or an
// explicit missing-transcript override, ISS-0024 precedent). An unpinned
// replay is not expressible: there is no overload that omits the pin
// target. A line that fails to parse as JSON (the corrupt-line
// capture-robustness corpus) passes through verbatim — never dropped, never
// edited, never thrown on. All other payload bytes are delivered unchanged.
//
// The default command invokes the BUILT hook artifact directly
// (dist/hook/capture.js) against the pin target as its init-root argv —
// identical bytes to what `init` copies into a repo's own
// .coreartifact/hooks/capture.mjs, so no per-repo install step is needed to
// replay against a real hook. Callers that need the INSTALLED copy's own
// semantics (a symlinked install path, a no-node_modules checkout — ISS-0004
// precedent) pass `options.command` explicitly.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtureStream, type ScenarioName } from "../../fixtures/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const HOOK_ARTIFACT = join(REPO_ROOT, "dist", "hook", "capture.js");

export interface ReplayInvocation {
  stdinBytes: Uint8Array;
  exitCode: number;
}

// Retained for callers that still destructure a wrapped shape (the fixtures
// layer's own SubstitutedReplayResult) — the harness's own primitives now
// return ReplayInvocation[] directly (ISS-0033 contract).
export interface ReplayResult {
  invocations: ReplayInvocation[];
}

export interface ReplayOptions {
  /** Override the invoked command; defaults to the built hook artifact against the pin target. */
  command?: string[];
  /** Override the pinned transcript_path instead of the default nonexistent sentinel. */
  transcriptPathOverride?: string;
}

function defaultCommand(pinTarget: string): string[] {
  return ["node", HOOK_ARTIFACT, pinTarget];
}

function sentinelTranscriptPath(pinTarget: string): string {
  return join(pinTarget, ".coreartifact-replay-no-transcript.jsonl");
}

// Pins cwd and transcript_path on a parseable payload line; a line that
// fails to parse is returned byte-for-byte unchanged (the corrupt-line
// corpus is delivered verbatim, never dropped, never edited).
function pinPayloadLine(line: string, pinTarget: string, transcriptPath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return line;
  const payload = parsed as Record<string, unknown>;
  payload.cwd = pinTarget;
  payload.transcript_path = transcriptPath;
  return JSON.stringify(payload);
}

function runOneInvocation(command: string[], payload: string): Promise<ReplayInvocation> {
  const [cmd, ...args] = command;
  if (!cmd) throw new Error("replayLines: empty command");
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

// Sequential replay of EXPLICIT lines against a pinned tmp-repo target —
// hermetic by construction: no caller can deliver a leftover recording
// machine's cwd/transcript_path, because pinning happens here, not at each
// call site (e.g. a truncated prefix of a recorded stream — a SIGKILLed
// session's stream just stops; this primitive only controls where the
// stream stops, never fabricates or edits payloads beyond the pin).
export async function replayLines(
  lines: string[],
  pinTarget: string,
  options: ReplayOptions = {},
): Promise<ReplayInvocation[]> {
  const command = options.command ?? defaultCommand(pinTarget);
  const transcriptPath = options.transcriptPathOverride ?? sentinelTranscriptPath(pinTarget);
  const invocations: ReplayInvocation[] = [];
  for (const line of lines) {
    const pinned = pinPayloadLine(line, pinTarget, transcriptPath);
    invocations.push(await runOneInvocation(command, pinned));
  }
  return invocations;
}

// Sequential, in order, one invocation per fixture line — a single scenario
// replayed against a pinned tmp-repo target.
export async function replayFixtures(
  scenario: ScenarioName,
  pinTarget: string,
  options: ReplayOptions = {},
): Promise<ReplayInvocation[]> {
  return replayLines(loadFixtureStream(scenario), pinTarget, options);
}

export interface ParallelReplayRequest {
  scenario: ScenarioName;
  pinTarget: string;
  options?: ReplayOptions;
}

// N interleaved parallel replays, each request carrying its own pin target
// (multi-repo tests pin different repos in one file, per call): each
// request's lines still land in order within that request, but requests run
// genuinely concurrently via Promise.all — the capture slice needs this to
// prove concurrent sessions lose zero lines.
export async function replayFixturesParallel(requests: ParallelReplayRequest[]): Promise<ReplayInvocation[][]> {
  return Promise.all(requests.map((request) => replayFixtures(request.scenario, request.pinTarget, request.options)));
}

let substitutedTranscriptCounter = 0;

// The sanctioned substitution, promoted into the harness (ISS-0033): pins
// cwd exactly like replayLines, but transcript_path defaults to a REAL
// tmpdir file holding the caller-supplied transcript content (never the
// nonexistent sentinel) unless the caller overrides it.
export async function replaySubstitutedTranscript(
  lines: string[],
  transcriptContent: string,
  pinTarget: string,
  options: ReplayOptions = {},
): Promise<ReplayInvocation[]> {
  let transcriptPath = options.transcriptPathOverride;
  if (transcriptPath === undefined) {
    substitutedTranscriptCounter += 1;
    transcriptPath = join(pinTarget, `substituted-transcript-${substitutedTranscriptCounter}.jsonl`);
    writeFileSync(transcriptPath, transcriptContent);
  }
  return replayLines(lines, pinTarget, { ...options, transcriptPathOverride: transcriptPath });
}
