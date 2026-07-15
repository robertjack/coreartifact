// The fixture replayer — primitive 3 of the acceptance harness (spec-v1.md
// "The acceptance harness", ISS-0003). Loads a fixture stream by scenario
// name through the fixtures issue's loader (never a raw path) and pipes each
// payload line into a supplied hook command on stdin, one process invocation
// per line, in order, delivering the payload bytes unchanged.
import { spawn } from "node:child_process";
import { loadFixtureStream, type ScenarioName } from "../../fixtures/loader.js";

export interface ReplayInvocation {
  stdinBytes: Uint8Array;
  exitCode: number;
}

export interface ReplayResult {
  invocations: ReplayInvocation[];
}

function runOneInvocation(command: string[], payload: string): Promise<ReplayInvocation> {
  const [cmd, ...args] = command;
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

// Sequential, in order, one invocation per fixture line — a single scenario
// replayed against one hook command.
export async function replayFixtures(scenario: ScenarioName, command: string[]): Promise<ReplayResult> {
  return replayLines(loadFixtureStream(scenario), command);
}

// Sequential replay of EXPLICIT lines (e.g. a prefix of a recorded stream —
// a truncated capture is exactly what the spool contains when a session is
// SIGKILLed mid-command: the stream just stops). The lines still come from
// a scenario via the loader; this primitive only controls where the stream
// stops, it never fabricates or edits payloads.
export async function replayLines(lines: string[], command: string[]): Promise<ReplayResult> {
  const invocations: ReplayInvocation[] = [];
  for (const line of lines) {
    invocations.push(await runOneInvocation(command, line));
  }
  return { invocations };
}

export interface ParallelReplayRequest {
  scenario: ScenarioName;
  command: string[];
}

// N interleaved parallel replays into the same (or distinct) hook command:
// each request's lines still land in order within that request, but requests
// run genuinely concurrently via Promise.all rather than one after another —
// the capture slice needs this to prove concurrent sessions lose zero lines.
// See tests/acceptance/harness.test.ts's parallel-replayer self-test (added
// 2026-07-14, S2b finding) for proof the target command receives exactly the
// sum of every request's lines, none lost, none duplicated.
export async function replayFixturesParallel(requests: ParallelReplayRequest[]): Promise<ReplayResult[]> {
  return Promise.all(requests.map((request) => replayFixtures(request.scenario, request.command)));
}
