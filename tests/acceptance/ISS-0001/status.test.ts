import { describe, it, expect } from "vitest";
import path from "node:path";
import { SRC_CORE, tryImport } from "./helpers.js";

const STATUS_MODULE = path.join(SRC_CORE, "status.ts");
const HOUR_MS = 60 * 60 * 1000;

describe("status", () => {
  it("deriveStatus returns closed-clean when an end timestamp is present, closed-inferred when there is no end timestamp and the last event is older than the staleness threshold constant of 12 hours, and open when there is no end timestamp and the last event is inside that threshold; recomputing with a newly supplied end timestamp returns closed-clean for an input that previously derived closed-inferred", async () => {
    const mod = await tryImport(STATUS_MODULE);
    if (!mod) throw new Error("not implemented yet: src/core/status.ts");
    const { deriveStatus } = mod;
    if (!deriveStatus) throw new Error("not implemented yet: deriveStatus export");

    // now / thresholds are literal, independent of any constant the module
    // might export -- the spec's own "12 hours" is the oracle here.
    const now = "2026-07-14T12:00:00.000Z";
    const nowMs = Date.parse(now);

    const withEnd = deriveStatus({
      endedAt: "2026-07-14T11:00:00.000Z",
      lastEventAt: "2026-07-14T11:00:00.000Z",
      now,
    });
    expect(withEnd).toBe("closed-clean");

    const staleLastEventAt = new Date(nowMs - 13 * HOUR_MS).toISOString();
    const inferredInput = { endedAt: null, lastEventAt: staleLastEventAt, now };
    const inferred = deriveStatus(inferredInput);
    expect(inferred).toBe("closed-inferred");

    const freshLastEventAt = new Date(nowMs - 1 * HOUR_MS).toISOString();
    const open = deriveStatus({ endedAt: null, lastEventAt: freshLastEventAt, now });
    expect(open).toBe("open");

    const recomputed = deriveStatus({ ...inferredInput, endedAt: now });
    expect(recomputed).toBe("closed-clean");
  });
});
