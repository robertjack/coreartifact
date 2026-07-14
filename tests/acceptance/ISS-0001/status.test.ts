import { describe, test, expect } from "vitest";

const MODULE_PATH = "../../../src/core/status";

async function loadStatusModule() {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

describe("ISS-0001 core contracts: status derivation", () => {
  test("deriveStatus returns closed-clean only when an end timestamp is genuinely present - an empty string or undefined endedAt is NOT a captured SessionEnd and must not fabricate closed-clean; it returns closed-inferred when there is no end timestamp and the last event is older than the staleness threshold constant of 12 hours, and open when there is no end timestamp and the last event is inside that threshold; recomputing with a newly supplied end timestamp returns closed-clean for an input that previously derived closed-inferred.", async () => {
    const mod = await loadStatusModule();
    if (!mod) throw new Error("src/core/status module not implemented yet");
    if (typeof mod.deriveStatus !== "function") {
      throw new Error("src/core/status does not export deriveStatus yet");
    }

    const now = "2026-07-14T12:00:00.000Z";
    const oneHourAgo = "2026-07-14T11:00:00.000Z"; // inside the 12h threshold
    const thirteenHoursAgo = "2026-07-13T23:00:00.000Z"; // 13h before `now`, older than the 12h threshold

    // A genuinely present end timestamp always yields closed-clean,
    // regardless of how stale the last event is.
    expect(
      mod.deriveStatus({ endedAt: "2026-07-14T11:59:00.000Z", lastEventTs: thirteenHoursAgo, now }),
    ).toBe("closed-clean");

    // Empty-string endedAt must NOT be treated as a captured SessionEnd.
    expect(
      mod.deriveStatus({ endedAt: "", lastEventTs: oneHourAgo, now }),
    ).toBe("open");
    expect(
      mod.deriveStatus({ endedAt: "", lastEventTs: thirteenHoursAgo, now }),
    ).toBe("closed-inferred");

    // Undefined endedAt must NOT be treated as a captured SessionEnd.
    expect(
      mod.deriveStatus({ endedAt: undefined, lastEventTs: oneHourAgo, now }),
    ).toBe("open");
    expect(
      mod.deriveStatus({ endedAt: undefined, lastEventTs: thirteenHoursAgo, now }),
    ).toBe("closed-inferred");

    // Recomputation is not a one-way door: the same last-event/now pair
    // that derived closed-inferred flips to closed-clean once an end
    // timestamp is genuinely supplied.
    const staleInput = { endedAt: undefined, lastEventTs: thirteenHoursAgo, now };
    expect(mod.deriveStatus(staleInput)).toBe("closed-inferred");
    expect(
      mod.deriveStatus({ ...staleInput, endedAt: "2026-07-14T11:59:00.000Z" }),
    ).toBe("closed-clean");
  });
});
