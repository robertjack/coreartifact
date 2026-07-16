// Unit coverage for src/ping/index.ts's awaitPingWithGrace — the ISS-0023
// S2 fix ("the fire-and-forget ping is awaited on the CLI critical path").
// Deterministic timing behavior with real (unmocked) timers: a resolved/
// fast promise returns immediately; a promise that never settles is
// abandoned once the grace elapses, never held onto for longer.
import { describe, it, expect } from "vitest";
import { awaitPingWithGrace, PING_EXIT_GRACE_MS } from "../../../src/ping/index.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("awaitPingWithGrace", () => {
  it("PING_EXIT_GRACE_MS is a short, named, positive constant", () => {
    expect(PING_EXIT_GRACE_MS).toBeGreaterThan(0);
    expect(PING_EXIT_GRACE_MS).toBeLessThanOrEqual(1000);
  });

  it("a ping that has already resolved returns essentially immediately", async () => {
    const resolved = Promise.resolve();
    const start = performance.now();
    await awaitPingWithGrace(resolved, PING_EXIT_GRACE_MS);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("a ping that resolves inside the grace window is awaited normally", async () => {
    const quick = delay(30);
    const start = performance.now();
    await awaitPingWithGrace(quick, PING_EXIT_GRACE_MS);
    const elapsed = performance.now() - start;
    // Should return once the ping resolves (~30ms), not wait out the full
    // grace (250ms).
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(200);
  });

  it("a ping that never settles is abandoned once the grace elapses, never held past it", async () => {
    const neverSettles = new Promise<void>(() => {
      // intentionally never resolves or rejects — stands in for a stalled
      // network attempt bounded only by the (much longer) transport
      // timeout, which this function must not wait out.
    });
    const start = performance.now();
    await awaitPingWithGrace(neverSettles, PING_EXIT_GRACE_MS);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(PING_EXIT_GRACE_MS - 20);
    // Generous CI margin, but discriminating against the old ~2000ms
    // await-after-handler behavior this replaces.
    expect(elapsed).toBeLessThan(600);
  });

  it("a ping that rejects late (after grace) never produces an unhandled rejection", async () => {
    let rejectFn: (err: Error) => void = () => {};
    const late = new Promise<void>((_resolve, reject) => {
      rejectFn = reject;
    }).catch(() => {
      // the caller (src/cli/index.ts) always attaches .catch before
      // handing the promise to awaitPingWithGrace — mirrored here.
    });

    const start = performance.now();
    await awaitPingWithGrace(late, PING_EXIT_GRACE_MS);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(PING_EXIT_GRACE_MS - 20);

    // Settle it after the grace already elapsed — must not throw/reject
    // anywhere observable.
    rejectFn(new Error("late transport failure"));
    await delay(10);
  });
});
