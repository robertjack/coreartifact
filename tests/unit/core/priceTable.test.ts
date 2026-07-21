// Unit tests for the pinned per-model price table (docs/issues/ISS-0019.md,
// gate ruling 2026-07-16). Pure arithmetic over already-parsed token
// counts — no ledger, no transcript file, no CLI subprocess.
import { describe, it, expect } from "vitest";
import { lookupModelRate, computeCostUsd } from "../../../src/core/priceTable.js";

describe("lookupModelRate", () => {
  it("returns the pinned rate for claude-fable-5", () => {
    expect(lookupModelRate("claude-fable-5")).toEqual({
      in: 10.0,
      out: 50.0,
      cacheRead: 1.0,
      write5m: 12.5,
      write1h: 20.0,
    });
  });

  it("returns the pinned rate for claude-haiku-4-5-20251001", () => {
    expect(lookupModelRate("claude-haiku-4-5-20251001")).toEqual({
      in: 1.0,
      out: 5.0,
      cacheRead: 0.1,
      write5m: 1.25,
      write1h: 2.0,
    });
  });

  it("returns the pinned rate for claude-sonnet-5 (observed-tier pin, 2026-07-20)", () => {
    expect(lookupModelRate("claude-sonnet-5")).toEqual({
      in: 3.0,
      out: 15.0,
      cacheRead: 0.3,
      write5m: 3.75,
      write1h: 6.0,
    });
  });

  it("returns null for a model deliberately unpinned this campaign (never a guessed rate)", () => {
    expect(lookupModelRate("claude-opus-4-8")).toBeNull();
  });

  it("never matches on an alias — pinned ids are exact strings only (repo law)", () => {
    expect(lookupModelRate("fable-5")).toBeNull();
    expect(lookupModelRate("claude-fable")).toBeNull();
  });
});

describe("computeCostUsd", () => {
  it("reproduces the cost-headless envelope oracle exactly (0.555957)", () => {
    const cost = computeCostUsd("claude-fable-5", {
      inputTokens: 12,
      outputTokens: 805,
      cacheReadTokens: 166807,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 17439,
    });
    expect(cost).toBe(0.555957);
  });

  it("reproduces the vitest envelope oracle exactly (0.438619)", () => {
    const cost = computeCostUsd("claude-fable-5", {
      inputTokens: 6,
      outputTokens: 486,
      cacheReadTokens: 70639,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 17181,
    });
    expect(cost).toBe(0.438619);
  });

  it("reproduces the background envelope oracle exactly (0.674005)", () => {
    const cost = computeCostUsd("claude-fable-5", {
      inputTokens: 10,
      outputTokens: 1586,
      cacheReadTokens: 149225,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 22269,
    });
    expect(cost).toBe(0.674005);
  });

  it("prices a 5m cache write at 1.25x input (structural rule) rather than the 1h rate", () => {
    const with5m = computeCostUsd("claude-fable-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 1_000_000,
      cacheCreation1hTokens: 0,
    });
    const with1h = computeCostUsd("claude-fable-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 1_000_000,
    });
    expect(with5m).toBe(12.5);
    expect(with1h).toBe(20.0);
    expect(with5m).not.toBe(with1h);
  });

  it("returns null (never zero or an estimate) for an unpinned model", () => {
    expect(
      computeCostUsd("claude-opus-4-8", {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
      }),
    ).toBeNull();
  });

  // Observed-tier pin validation (2026-07-20 daily-lane): reproduces one of
  // the seven real aeh-attempt pairs used to derive the pinned rates —
  // session f60a4043-186e-4c6e-abd5-d8f07111ad58, ledger tokens cross-
  // referenced against .aeh/aeh.db attempts.cost_usd (2.2992285), all
  // cache-creation billed at the 1h TTL rate.
  it("reproduces a real claude-sonnet-5 aeh-attempt cost exactly at the standard tier (session f60a4043...)", () => {
    const cost = computeCostUsd("claude-sonnet-5", {
      inputTokens: 40,
      outputTokens: 38237,
      cacheReadTokens: 2389245,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 168130,
    });
    expect(cost).toBe(2.2992285);
  });
});
