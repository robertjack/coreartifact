// F121 (ISS-0017 round-2 review): streaming passthrough had zero coverage.
// The behavior worked (reviewer verified by execution) but nothing here
// would go red if a future change silently regressed it back to
// capture-and-swallow -- a check command's live output would vanish from
// the caller's terminal while the spool still looked fine. This drives
// runCheckedCommand directly against a real child process that emits
// distinct markers on stdout and stderr, and asserts BOTH streams: relayed
// live to the caller's own process.stdout/stderr, AND captured into the
// returned result for the spool line.
import { describe, it, expect, afterEach } from "vitest";
import { runCheckedCommand } from "../../../src/check/run.js";

describe("runCheckedCommand: streaming passthrough", () => {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  it("relays distinct stdout and stderr markers to the caller's own streams AND captures both", async () => {
    const relayedStdout: string[] = [];
    const relayedStderr: string[] = [];

    // Monkeypatch the real global process streams -- run.ts's own `declare
    // const process` type shim resolves to this same global object at
    // runtime, so intercepting writes here observes exactly what a live
    // caller's terminal would have received.
    (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
      relayedStdout.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    };
    (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
      relayedStderr.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    };

    const script =
      "process.stdout.write('stdout-marker-run-test'); process.stderr.write('stderr-marker-run-test');";
    const result = await runCheckedCommand(["node", "-e", script]);

    expect(result.exitCode, "wrapped command's own exit code must pass through").toBe(0);

    expect(
      relayedStdout.join(""),
      "the child's stdout marker must be relayed live to the caller's own stdout",
    ).toContain("stdout-marker-run-test");
    expect(
      relayedStderr.join(""),
      "the child's stderr marker must be relayed live to the caller's own stderr",
    ).toContain("stderr-marker-run-test");

    expect(
      result.output,
      "the combined captured output must also include the stdout marker (for the spool line)",
    ).toContain("stdout-marker-run-test");
    expect(
      result.output,
      "the combined captured output must also include the stderr marker (for the spool line)",
    ).toContain("stderr-marker-run-test");
  });
});
