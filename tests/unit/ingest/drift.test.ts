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
});
