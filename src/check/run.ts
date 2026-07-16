// Runs the wrapped command (docs/issues/ISS-0017.md "Command behavior"): the
// child's combined stdout+stderr streams through to the user as it runs
// (check wraps, it does not swallow) and is simultaneously captured for the
// spool line. Exit code passthrough is exact; a signal kill maps to the
// conventional 128+signal code.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:child_process import below is
// `@ts-ignore`d at the import site and re-typed through a local interface
// describing only the surface this file calls, same pattern as
// src/install/gitRepo.ts.

// @ts-ignore -- node:child_process has no ambient types available in this sandbox
import { spawn as spawnFn } from "node:child_process";

interface ChunkLike {
  toString(encoding: string): string;
}

interface ReadableStreamLike {
  on(event: "data", listener: (chunk: ChunkLike) => void): void;
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
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
};

// Conventional Unix signal numbers for the names a killed child process
// reports (Node's own `on("close", (code, signal))` gives the signal name,
// never its number). Only the signals Node can actually report here are
// listed; an unrecognized name still yields a nonzero, named-in-spirit exit
// via the 128 floor rather than silently claiming success.
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

function exitCodeFor(code: number | null, signal: string | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + (SIGNAL_NUMBERS[signal] ?? 0);
  return 1;
}

export interface CheckRunResult {
  exitCode: number;
  output: string;
}

// Runs `argv` as a child process from the current directory, streaming its
// combined stdout+stderr to this process's own stdout/stderr as it runs
// while also accumulating it for the spool line.
export function runCheckedCommand(argv: string[]): Promise<CheckRunResult> {
  const [command, ...args] = argv;
  return new Promise((resolvePromise, reject) => {
    if (!command) {
      reject(new Error("runCheckedCommand: empty argv"));
      return;
    }
    const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
    let output = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      process.stdout.write(text);
      output += text;
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      process.stderr.write(text);
      output += text;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolvePromise({ exitCode: exitCodeFor(code, signal), output });
    });
  });
}
