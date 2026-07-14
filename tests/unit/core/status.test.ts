import { describe, it, expect } from "vitest";
import { deriveStatus, STALENESS_THRESHOLD_MS } from "../../../src/core/status.js";

describe("deriveStatus", () => {
  it("exports a 12 hour staleness threshold", () => {
    expect(STALENESS_THRESHOLD_MS).toBe(12 * 60 * 60 * 1000);
  });

  it("is open exactly at the staleness boundary (not yet older than the threshold)", () => {
    const now = "2026-07-14T12:00:00.000Z";
    const exactlyTwelveHoursAgo = "2026-07-14T00:00:00.000Z";
    expect(deriveStatus({ lastEventTs: exactlyTwelveHoursAgo, now })).toBe("open");
  });

  it("is closed-inferred just past the staleness boundary", () => {
    const now = "2026-07-14T12:00:00.000Z";
    const justOverTwelveHoursAgo = "2026-07-13T23:59:59.000Z";
    expect(deriveStatus({ lastEventTs: justOverTwelveHoursAgo, now })).toBe("closed-inferred");
  });

  it("treats a missing endedAt key the same as an explicit undefined", () => {
    const now = "2026-07-14T12:00:00.000Z";
    const oneHourAgo = "2026-07-14T11:00:00.000Z";
    expect(deriveStatus({ lastEventTs: oneHourAgo, now })).toBe("open");
  });

  // F5 regression: `new Date("garbage").getTime()` is NaN, and
  // `NaN > threshold` is false, so a naive implementation falls through to
  // "open" — fabricating liveness forever for a session with a corrupt
  // timestamp. This function must fail toward "we don't know"
  // (closed-inferred), never toward the flattering "open" claim.
  it("derives closed-inferred, never open, when lastEventTs is unparseable", () => {
    const now = "2026-07-14T12:00:00.000Z";
    expect(deriveStatus({ lastEventTs: "garbage", now })).toBe("closed-inferred");
  });

  it("derives closed-inferred, never open, when now is unparseable", () => {
    const lastEventTs = "2026-07-14T11:00:00.000Z";
    expect(deriveStatus({ lastEventTs, now: "not-a-date" })).toBe("closed-inferred");
  });

  it("derives closed-inferred, never open, when both timestamps are unparseable", () => {
    expect(deriveStatus({ lastEventTs: "garbage", now: "also garbage" })).toBe("closed-inferred");
  });

  it("a genuinely present endedAt still overrides an unparseable lastEventTs with closed-clean", () => {
    const now = "2026-07-14T12:00:00.000Z";
    expect(
      deriveStatus({ endedAt: "2026-07-14T11:59:00.000Z", lastEventTs: "garbage", now }),
    ).toBe("closed-clean");
  });
});
