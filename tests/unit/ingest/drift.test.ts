// Pure unit tests for src/ingest/drift.ts — the classification ladder
// (docs/issues/ISS-0020.md "The kind reconciliation").
import { describe, it, expect } from "vitest";
import { classifySessionKind, type DriftEvent } from "../../../src/ingest/drift.js";
import { KIND_ABSENCE_REASONS } from "../../../src/core/absence.js";

describe("classifySessionKind", () => {
  it("rule 1: SessionStart with model -> interactive", () => {
    const events: DriftEvent[] = [
      { hookEventName: "SessionStart", eventObj: { model: "claude-fable-5" } },
      { hookEventName: "SessionEnd", eventObj: { reason: "prompt_input_exit" } },
    ];
    expect(classifySessionKind(events)).toEqual({ kind: "interactive", reason: null });
  });

  it("rule 2: SessionStart without model, SessionEnd reason other -> headless", () => {
    const events: DriftEvent[] = [
      { hookEventName: "SessionStart", eventObj: { source: "startup" } },
      { hookEventName: "SessionEnd", eventObj: { reason: "other" } },
    ];
    expect(classifySessionKind(events)).toEqual({ kind: "headless", reason: null });
  });

  it("rule 2: SessionStart without model, no SessionEnd at all (SIGKILL-shaped) -> headless, never rule 3", () => {
    const events: DriftEvent[] = [{ hookEventName: "SessionStart", eventObj: { source: "startup" } }];
    expect(classifySessionKind(events)).toEqual({ kind: "headless", reason: null });
  });

  it("rule 3: SessionStart without model, SessionEnd reason prompt_input_exit -> ABSENT, contradicted", () => {
    const events: DriftEvent[] = [
      { hookEventName: "SessionStart", eventObj: { source: "startup" } },
      { hookEventName: "SessionEnd", eventObj: { reason: "prompt_input_exit" } },
    ];
    expect(classifySessionKind(events)).toEqual({
      kind: null,
      reason: KIND_ABSENCE_REASONS.MODEL_ABSENT_CONTRADICTED_BY_END_REASON,
    });
  });

  it("rule 4: no SessionStart line at all -> ABSENT, no SessionStart captured", () => {
    const events: DriftEvent[] = [{ hookEventName: "SessionEnd", eventObj: { reason: "other" } }];
    expect(classifySessionKind(events)).toEqual({
      kind: null,
      reason: KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED,
    });
  });

  it("rule 1 wins regardless of end-reason: model present classifies interactive even with a contradicting-shaped end reason absent", () => {
    const events: DriftEvent[] = [{ hookEventName: "SessionStart", eventObj: { model: "claude-fable-5" } }];
    expect(classifySessionKind(events)).toEqual({ kind: "interactive", reason: null });
  });

  it("never infers kind from non-boundary events", () => {
    const events: DriftEvent[] = [
      { hookEventName: "SessionStart", eventObj: { source: "startup" } },
      { hookEventName: "UserPromptSubmit", eventObj: { effort: { level: "xhigh" } } },
      { hookEventName: "SessionEnd", eventObj: { reason: "other" } },
    ];
    expect(classifySessionKind(events)).toEqual({ kind: "headless", reason: null });
  });

  // ISS-0025: the source-demote gate (docs/recording-pass.md findings 3 and
  // 9) -- model absent AND source anything other than "startup" is an
  // unverified start mode, never classified.
  describe("ISS-0025: source-demote gate", () => {
    it("rule 5: SessionStart without model, source 'clear' (the recorded real case) -> ABSENT, naming the source", () => {
      const events: DriftEvent[] = [{ hookEventName: "SessionStart", eventObj: { source: "clear" } }];
      expect(classifySessionKind(events)).toEqual({
        kind: null,
        reason: KIND_ABSENCE_REASONS.sourceNotStartup("clear"),
      });
      expect(classifySessionKind(events).reason).toContain("clear");
    });

    it("rule 5 wins even with a SessionEnd that would otherwise classify headless -- the source gate runs before the end-reason corroboration", () => {
      const events: DriftEvent[] = [
        { hookEventName: "SessionStart", eventObj: { source: "clear" } },
        { hookEventName: "SessionEnd", eventObj: { reason: "other" } },
      ];
      expect(classifySessionKind(events)).toEqual({
        kind: null,
        reason: KIND_ABSENCE_REASONS.sourceNotStartup("clear"),
      });
    });

    it("rule 4: SessionStart without model, no source key at all -> ABSENT, no source recorded", () => {
      const events: DriftEvent[] = [{ hookEventName: "SessionStart", eventObj: {} }];
      expect(classifySessionKind(events)).toEqual({
        kind: null,
        reason: KIND_ABSENCE_REASONS.MODEL_ABSENT_NO_SOURCE_RECORDED,
      });
    });

    it("a non-string source value is treated the same as a missing source key (never fabricated)", () => {
      const events: DriftEvent[] = [{ hookEventName: "SessionStart", eventObj: { source: 42 } }];
      expect(classifySessionKind(events)).toEqual({
        kind: null,
        reason: KIND_ABSENCE_REASONS.MODEL_ABSENT_NO_SOURCE_RECORDED,
      });
    });

    it("rule 2/3 (startup source) are unchanged: source 'startup' still reaches the end-reason corroboration", () => {
      const contradicted: DriftEvent[] = [
        { hookEventName: "SessionStart", eventObj: { source: "startup" } },
        { hookEventName: "SessionEnd", eventObj: { reason: "prompt_input_exit" } },
      ];
      expect(classifySessionKind(contradicted)).toEqual({
        kind: null,
        reason: KIND_ABSENCE_REASONS.MODEL_ABSENT_CONTRADICTED_BY_END_REASON,
      });
    });

    // Review fix round 1, S2 #1: an empty-string `source` is unnameable the
    // same way a missing key or a non-string value is -- it must fold to
    // MODEL_ABSENT_NO_SOURCE_RECORDED, never to the bare
    // "model absent, source not startup: " (nothing after the prefix),
    // which the closed-vocabulary validator in src/core/absence.ts rejects
    // (`reason.length > PREFIX.length`). Getting this wrong throws INSIDE
    // the ingest transaction and wedges the whole repo's ledger permanently
    // (execution-proven by the adversarial reviewer -- a regression against
    // main, which classified "" -> headless without throwing).
    it("review fix round 1: SessionStart with source '' (empty string) folds to no-source-recorded, never the bare prefix", () => {
      const events: DriftEvent[] = [{ hookEventName: "SessionStart", eventObj: { source: "" } }];
      expect(classifySessionKind(events)).toEqual({
        kind: null,
        reason: KIND_ABSENCE_REASONS.MODEL_ABSENT_NO_SOURCE_RECORDED,
      });
    });

    // Review fix round 1, S2 #2: every existing assertion used source
    // "clear", which happens to equal the precomputed
    // MODEL_ABSENT_SOURCE_NOT_STARTUP_CLEAR constant -- a builder that
    // ignores its argument and always returns the "clear" literal would
    // still pass those. These assertions hardcode the expected string
    // independently of KIND_ABSENCE_REASONS.sourceNotStartup itself (never
    // call the builder to compute the expected value) so an
    // argument-ignoring mutant is caught.
    it("review fix round 1: the reason embeds the ACTUAL observed source value ('resume'), not a fixed literal", () => {
      const events: DriftEvent[] = [{ hookEventName: "SessionStart", eventObj: { source: "resume" } }];
      expect(classifySessionKind(events)).toEqual({
        kind: null,
        reason: "model absent, source not startup: resume",
      });
    });

    it("review fix round 1: the reason embeds the ACTUAL observed source value ('compact'), not a fixed literal", () => {
      const events: DriftEvent[] = [{ hookEventName: "SessionStart", eventObj: { source: "compact" } }];
      const result = classifySessionKind(events);
      expect(result).toEqual({
        kind: null,
        reason: "model absent, source not startup: compact",
      });
      // Distinctness against the "clear" and "resume" cells directly, so a
      // builder collapsed to any single fixed literal is caught regardless
      // of which literal it collapsed to.
      expect(result.reason).not.toBe("model absent, source not startup: clear");
      expect(result.reason).not.toBe("model absent, source not startup: resume");
    });
  });
});
