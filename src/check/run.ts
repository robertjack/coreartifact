// Runs the wrapped command (docs/issues/ISS-0017.md "Command behavior"): the
// child's combined stdout+stderr streams through to the user as it runs
// (check wraps, it does not swallow) and is simultaneously captured for the
// spool line. Exit code passthrough is exact; a signal kill maps to the
// conventional 128+signal code.
//
// F125 (S2, ISS-0017 round-4 review, borders S1): this used to accumulate
// EVERY chunk of the child's combined output unboundedly, then run
// `Buffer.concat(chunks).toString("utf8")` ONCE at close over the whole
// thing. Measured by execution: a >512 MB combined output crashes that
// single `Buffer.concat().toString()` call with a RangeError -- `check`
// exits 1 while the wrapped command itself exited 0, and (since the crash
// happens before serializeCheckLine ever runs) NO spool line is written at
// all -- the exact silent-evidence-loss shape this issue exists to prevent.
// Separately measured: 1.64 GB peak RSS just to capture a 32 KiB STORED
// output, because the full unbounded buffer was retained in memory the
// entire time regardless of what the cap (src/check/cap.ts) would keep.
//
// The fix: passthrough to the caller's own stdout/stderr stays byte-for-byte
// unbounded (check wraps, never truncates what the user sees LIVE), but the
// RETAINED copy -- the one this function decodes and hands back for the
// spool line -- is capped at CHECK_OUTPUT_CAP_BYTES plus a small
// codepoint-boundary margin, regardless of how much total data streams
// through. Anything beyond the retention cap is written through and then
// immediately dropped, never buffered. This reproduces the F114 multi-byte
// boundary guarantee at the retention cutoff instead of at decode time: the
// margin (big enough for one whole UTF-8 codepoint) guarantees any
// corruption from cutting mid-character lands strictly PAST
// CHECK_OUTPUT_CAP_BYTES, which capOutput (src/check/cap.ts) already trims
// away on its own codepoint-boundary backoff -- so decoding only the
// retained bytes here never changes what capOutput ultimately stores.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:child_process import below is
// `@ts-ignore`d at the import site and re-typed through a local interface
// describing only the surface this file calls, same pattern as
// src/install/gitRepo.ts.

// @ts-ignore -- node:child_process has no ambient types available in this sandbox
import { spawn as spawnFn } from "node:child_process";
// @ts-ignore -- node:os has no ambient types available in this sandbox
import { constants as osConstantsFn } from "node:os";
import { CHECK_OUTPUT_CAP_BYTES } from "./cap.js";

// Chunks off a child's stdio pipe are raw Buffers. Decoding each chunk to
// UTF-8 independently (the bug this shape prevents) corrupts any multi-byte
// character whose bytes straddle a chunk boundary into U+FFFD on both sides
// -- the passthrough stream AND the spool-captured output, which is
// unrecoverable by re-ingest since the spool is ground truth forever.
// Raw chunks are written through untouched; only the bounded RETAINED subset
// is concatenated+decoded once, after the child closes (see block comment
// above).
interface NodeBufferLike {
  readonly length: number;
  subarray(start?: number, end?: number): NodeBufferLike;
}
declare const Buffer: {
  concat(chunks: NodeBufferLike[]): { toString(encoding: string): string };
};

// The maximum UTF-8 codepoint is 4 bytes -- this margin guarantees that
// whatever character straddles the retention cutoff (RETENTION_CAP_BYTES)
// is captured WHOLE in the retained buffer, so capOutput's own backoff logic
// (which operates at CHECK_OUTPUT_CAP_BYTES, strictly less than the
// retention cutoff) never sees a character truncated by retention itself --
// only truncation it decides on its own.
const RETENTION_MARGIN_BYTES = 4;
export const DEFAULT_RETENTION_CAP_BYTES = CHECK_OUTPUT_CAP_BYTES + RETENTION_MARGIN_BYTES;

interface ReadableStreamLike {
  on(event: "data", listener: (chunk: NodeBufferLike) => void): void;
}

interface ChildProcessLike {
  stdout: ReadableStreamLike;
  stderr: ReadableStreamLike;
  on(event: "error", listener: (err: unknown) => void): void;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
}

interface SpawnOptions {
  cwd?: string;
  stdio: [string, string, string];
}

const spawn = spawnFn as (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;

declare const process: {
  stdout: { write(chunk: NodeBufferLike): boolean };
  stderr: { write(chunk: NodeBufferLike): boolean };
};

// Signal name -> number, read from node:os's own platform-reported table
// (F150) rather than a hand-maintained constant map. The previous
// hand-written table hard-coded Linux numbers (e.g. SIGBUS: 7, SIGUSR1: 10,
// SIGUSR2: 12) which are WRONG on darwin (SIGBUS: 10, SIGUSR1: 30,
// SIGUSR2: 31 -- verified via `node -e "console.log(require('os').constants.signals)"`
// on this machine) -- portable by construction, no table to drift as
// platforms are added. Only the signals Node can actually report here are
// listed; an unrecognized name still yields a nonzero, named-in-spirit exit
// via the 128 floor rather than silently claiming success.
const SIGNAL_NUMBERS: Record<string, number> = osConstantsFn.signals as Record<string, number>;

function exitCodeFor(code: number | null, signal: string | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + (SIGNAL_NUMBERS[signal] ?? 0);
  return 1;
}

export interface CheckRunResult {
  exitCode: number;
  output: string;
}

export interface RunCheckedCommandOptions {
  /**
   * Overrides DEFAULT_RETENTION_CAP_BYTES -- test-only seam (F125): a unit
   * test can lower this to prove retention is bounded without ever having
   * to emit hundreds of megabytes of real data. Production callers never
   * pass this.
   */
  retentionCapBytes?: number;
}

// Runs `argv` as a child process from the current directory, streaming its
// combined stdout+stderr to this process's own stdout/stderr as it runs
// (unbounded -- the live passthrough never truncates) while also retaining
// AT MOST `retentionCapBytes` of that same combined stream for the spool
// line (F125). Once the retained buffer reaches the cap, further chunks are
// still written through live but no longer copied into memory.
export function runCheckedCommand(
  argv: string[],
  options: RunCheckedCommandOptions = {},
): Promise<CheckRunResult> {
  const retentionCapBytes = options.retentionCapBytes ?? DEFAULT_RETENTION_CAP_BYTES;
  const [command, ...args] = argv;
  return new Promise((resolvePromise, reject) => {
    if (!command) {
      reject(new Error("runCheckedCommand: empty argv"));
      return;
    }
    const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
    const retainedChunks: NodeBufferLike[] = [];
    let retainedBytes = 0;

    // Passthrough is ALWAYS the full chunk, unbounded -- retention is capped
    // independently and never affects what the caller's own terminal sees
    // live.
    function retain(chunk: NodeBufferLike): void {
      if (retainedBytes >= retentionCapBytes) return;
      const room = retentionCapBytes - retainedBytes;
      if (chunk.length <= room) {
        retainedChunks.push(chunk);
        retainedBytes += chunk.length;
      } else {
        retainedChunks.push(chunk.subarray(0, room));
        retainedBytes = retentionCapBytes;
      }
    }

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      retain(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      retain(chunk);
    });

    // F148 (S3): a spawn failure (e.g. ENOENT -- the wrapped command's
    // binary doesn't exist) used to `reject` here, which propagated as an
    // uncaught rejection all the way out through checkCommand's un-guarded
    // `await` -- the process crashed and NOTHING landed in the spool. The
    // evidence law says failures are evidence too: a spawn failure is
    // recorded as a check line exactly like any other failed run, using the
    // conventional "command not found" exit code (127) with the error's own
    // message as the output, rather than crashing or staying silent. `close`
    // never fires after a spawn-time `error` for this failure shape, but the
    // flag still guards against any double-settle if that assumption ever
    // proves wrong for some platform/child-process edge case.
    let settled = false;
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      const message = err instanceof Error ? err.message : String(err);
      resolvePromise({ exitCode: 127, output: message });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      // Only the bounded retained subset is ever concatenated+decoded --
      // never the full, unbounded stream (F125's fix: this is what keeps
      // both memory AND this Buffer.concat/toString call bounded regardless
      // of how much data actually streamed through above).
      const output = Buffer.concat(retainedChunks).toString("utf8");
      resolvePromise({ exitCode: exitCodeFor(code, signal), output });
    });
  });
}
