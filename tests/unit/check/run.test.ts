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
import { constants as osConstants } from "node:os";
import { runCheckedCommand } from "../../../src/check/run.js";
import { capOutput } from "../../../src/check/cap.js";
import { serializeCheckLine } from "../../../src/core/envelope.js";

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

// F125 (S2, ISS-0017 round-4 review, borders S1): before the fix,
// runCheckedCommand accumulated EVERY chunk of the child's combined output
// unboundedly and only concatenated+decoded the WHOLE thing once at close.
// A >512 MB combined output measurably crashed that final
// `Buffer.concat().toString()` with a RangeError -- exit 1 while the
// wrapped command itself exited 0, and NO spool line written at all (the
// crash happens before serializeCheckLine ever runs). Separately measured:
// 1.64 GB peak RSS to capture a 32 KiB STORED output.
//
// Emitting hundreds of megabytes in a test is neither necessary nor kind to
// CI -- the injectable `retentionCapBytes` seam (test-only) proves the same
// property at a few MB instead: retention is bounded independent of how
// much data actually streams through, while the LIVE passthrough stays
// byte-for-byte unbounded.
describe("runCheckedCommand: bounded retention (F125)", () => {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  it(
    "retains at most retentionCapBytes in memory while passing the FULL stream through live, unbounded",
    async () => {
      let passedThroughBytes = 0;
      (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
        passedThroughBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), "utf8");
        return true;
      };

      const CHUNK_BYTES = 65536;
      const CHUNK_COUNT = 40; // ~2.5 MB total -- deliberately far over any sane cap, never anywhere near 512 MB.
      const RETENTION_CAP_BYTES = 1024;
      const TOTAL_EMITTED_BYTES = CHUNK_BYTES * CHUNK_COUNT;

      // fs.writeSync(1, ...) rather than process.stdout.write + process.exit():
      // stdout is a non-blocking pipe, and an immediate process.exit() after
      // async writes truncates whatever hadn't flushed yet -- a real Node
      // gotcha, not the thing this test is proving. A synchronous write
      // guarantees every byte is in the pipe before the loop's next
      // iteration, so process.exit(3) below is safe.
      const script = `
        const fs = require("fs");
        const buf = Buffer.alloc(${CHUNK_BYTES}, "a");
        for (let i = 0; i < ${CHUNK_COUNT}; i++) { fs.writeSync(1, buf); }
        process.exit(3);
      `;

      const result = await runCheckedCommand(["node", "-e", script], {
        retentionCapBytes: RETENTION_CAP_BYTES,
      });

      expect(result.exitCode, "the wrapped command's own exit code must still pass through").toBe(3);

      expect(
        passedThroughBytes,
        "the LIVE passthrough to the caller's own stdout must be the full, untruncated stream",
      ).toBe(TOTAL_EMITTED_BYTES);

      expect(
        Buffer.byteLength(result.output, "utf8"),
        "the RETAINED (captured) output must never exceed the injected retention cap, regardless of how much data streamed through",
      ).toBeLessThanOrEqual(RETENTION_CAP_BYTES);

      // "the check still records": the retained output must still be a
      // valid input to the rest of the spool-line pipeline -- capOutput and
      // serializeCheckLine must both succeed on it without throwing, and
      // the wrapped command's exit code must still be the one carried
      // through to the spool line.
      const capped = capOutput(result.output);
      const serialized = serializeCheckLine({
        v: 1,
        ts: new Date().toISOString(),
        check: {
          name: "f125-retention",
          argv: ["node", "-e", script],
          exit: result.exitCode,
          output: capped.output,
          truncated: capped.truncated,
          session_id: null,
          bound_by: null,
        },
      });
      expect(serialized.ok, "the retained, capped output must still serialize into a valid check line").toBe(
        true,
      );
    },
    30000,
  );

  // F114's multi-byte boundary guarantee must still hold now that retention
  // (not just capOutput) has its own cutoff. Using the DEFAULT retention cap
  // (CHECK_OUTPUT_CAP_BYTES + a small margin, no injected override) with the
  // exact byte-straddling case cap.test.ts already proves at the capOutput
  // level directly: 'x' followed by CHECK_OUTPUT_CAP_BYTES/2 'é' characters
  // is one byte over the cap, with the boundary landing on the first byte of
  // a 2-byte 'é'. The margin must be large enough that retention's own
  // decode never corrupts the character capOutput is about to correctly
  // back off from.
  it("keeps the F114 multi-byte boundary guarantee when the cut happens at the DEFAULT retention cutoff", async () => {
    // Passthrough is unbounded by design (F125) -- silence it here purely so
    // this test doesn't dump ~32 KiB of 'é' to the runner's own terminal;
    // the assertions below still exercise the full, real passthrough path.
    (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = () => true;

    const REPEAT = 16384; // 'x' + 'é'.repeat(16384) = 1 + 2*16384 = 32769 bytes, one over CHECK_OUTPUT_CAP_BYTES (32768).
    const script = `
      const fs = require("fs");
      fs.writeSync(1, "x");
      const chunk = Buffer.from("é".repeat(1024), "utf8");
      for (let i = 0; i < ${REPEAT / 1024}; i++) { fs.writeSync(1, chunk); }
      process.exit(0);
    `;

    const result = await runCheckedCommand(["node", "-e", script]);
    expect(result.exitCode).toBe(0);

    const capped = capOutput(result.output);
    const expected = "x" + "é".repeat(REPEAT - 1);
    expect(capped.output, "the retained+capped output must back off the SAME way capOutput does standalone").toBe(
      expected,
    );
    expect(capped.truncated).toBe(true);
    expect(capped.output).not.toMatch(/�/);
  });
});

// F148 (S3): a wrapped command whose binary can't even be spawned (ENOENT)
// used to reject the returned promise, which propagated all the way out
// through checkCommand's un-guarded `await` as an uncaught crash -- NOTHING
// landed in the spool, the exact silent-evidence-loss shape this issue
// exists to prevent. A spawn failure must instead resolve like any other
// failed run: a nonzero exit code (the conventional 127, "command not
// found") and the error's own message as the output, so the caller can
// still build and write a normal check line.
describe("runCheckedCommand: spawn failure records evidence (F148)", () => {
  it("resolves (never rejects) with exit code 127 and the spawn error's message as output", async () => {
    const result = await runCheckedCommand(["coreartifact-daily-lane-does-not-exist-anywhere-on-path"]);

    expect(result.exitCode, "an unspawnable command must record the conventional 127, not crash").toBe(127);
    expect(
      result.output,
      "the spawn error's own message must be captured as the check's output, not silently dropped",
    ).toMatch(/ENOENT|not found|coreartifact-daily-lane-does-not-exist-anywhere-on-path/);
  });
});

// F150 (S3): signal -> exit code used to go through a hand-written table of
// Linux signal numbers, which is wrong on darwin (e.g. SIGBUS is 7 on Linux
// but 10 on darwin). Deriving the table from node:os's own
// platform-reported `constants.signals` makes this correct on whatever
// platform the test itself runs on, with no hardcoded per-OS number in the
// test either. SIGUSR2 (not SIGUSR1) is used to self-signal: Node treats an
// incoming SIGUSR1 specially (it starts the inspector rather than
// terminating the process), which would make this test measure Node's own
// debugger handling instead of the signal-to-exit-code mapping.
describe("runCheckedCommand: portable signal-to-exit-code mapping (F150)", () => {
  it("maps a killed child's signal to 128 + the PLATFORM's own signal number", async () => {
    const script = "process.kill(process.pid, 'SIGUSR2');";
    const result = await runCheckedCommand(["node", "-e", script]);

    const expectedExitCode = 128 + (osConstants.signals as Record<string, number>).SIGUSR2;
    expect(
      result.exitCode,
      "the reported exit code must be 128 + this platform's own SIGUSR2 number, not a hardcoded Linux value",
    ).toBe(expectedExitCode);
  });
});
