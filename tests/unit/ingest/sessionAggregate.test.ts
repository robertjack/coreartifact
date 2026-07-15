// Pure unit tests for src/ingest/sessionAggregate.ts (docs/issues/ISS-0006.md
// "Below-the-seam unit tests ... session aggregate folding").
import { describe, it, expect } from "vitest";
import { foldSessionFacets, type FoldableEvent } from "../../../src/ingest/sessionAggregate.js";

describe("foldSessionFacets", () => {
  it("derives kind interactive when SessionStart carries a model key", () => {
    const events: FoldableEvent[] = [
      { ts: "2026-07-14T00:00:00.000Z", hookEventName: "SessionStart", eventObj: { model: "claude-fable-5" } },
    ];
    expect(foldSessionFacets(events).kind).toBe("interactive");
  });

  it("derives kind headless when SessionStart is present but lacks a model key", () => {
    const events: FoldableEvent[] = [
      { ts: "2026-07-14T00:00:00.000Z", hookEventName: "SessionStart", eventObj: { source: "startup" } },
    ];
    expect(foldSessionFacets(events).kind).toBe("headless");
  });

  it("never infers kind from a non-SessionStart event, even ones that look suggestive", () => {
    const events: FoldableEvent[] = [
      { ts: "2026-07-14T00:00:00.000Z", hookEventName: "UserPromptSubmit", eventObj: { effort: { level: "xhigh" } } },
      { ts: "2026-07-14T00:00:01.000Z", hookEventName: "PreToolUse", eventObj: { tool_name: "Bash" } },
    ];
    // No SessionStart in this batch at all -> kind stays null (ABSENT), the
    // drift fallback — never guessed from `effort` or any other field.
    expect(foldSessionFacets(events).kind).toBeNull();
  });

  it("reads sha_before from SessionStart's git.head and sha_after from SessionEnd's, leaving each ABSENT (null) when its boundary has no git sibling", () => {
    const startOnly: FoldableEvent[] = [
      { ts: "2026-07-14T00:00:00.000Z", hookEventName: "SessionStart", eventObj: {}, git: { head: "abc123" } },
    ];
    const startDelta = foldSessionFacets(startOnly);
    expect(startDelta.shaBefore).toBe("abc123");
    expect(startDelta.shaAfter).toBeNull();

    const endOnly: FoldableEvent[] = [
      { ts: "2026-07-14T00:05:00.000Z", hookEventName: "SessionEnd", eventObj: {}, git: { head: "def456" } },
    ];
    const endDelta = foldSessionFacets(endOnly);
    expect(endDelta.shaAfter).toBe("def456");
    expect(endDelta.shaBefore).toBeNull();
  });

  it("leaves sha_before/sha_after ABSENT (null), never fabricated, when a boundary event carries no git sibling", () => {
    const events: FoldableEvent[] = [
      { ts: "2026-07-14T00:00:00.000Z", hookEventName: "SessionStart", eventObj: {} },
      { ts: "2026-07-14T00:05:00.000Z", hookEventName: "SessionEnd", eventObj: {} },
    ];
    const delta = foldSessionFacets(events);
    expect(delta.shaBefore).toBeNull();
    expect(delta.shaAfter).toBeNull();
  });

  it("sets ended_at to SessionEnd's ts, and leaves it null when no SessionEnd is present", () => {
    const withEnd: FoldableEvent[] = [
      { ts: "2026-07-14T00:00:00.000Z", hookEventName: "SessionStart", eventObj: {} },
      { ts: "2026-07-14T00:05:00.000Z", hookEventName: "SessionEnd", eventObj: {} },
    ];
    expect(foldSessionFacets(withEnd).endedAt).toBe("2026-07-14T00:05:00.000Z");

    const withoutEnd: FoldableEvent[] = [
      { ts: "2026-07-14T00:00:00.000Z", hookEventName: "SessionStart", eventObj: {} },
    ];
    expect(foldSessionFacets(withoutEnd).endedAt).toBeNull();
  });

  it("derives minTs/maxTs from the earliest and latest event, independent of input order", () => {
    const events: FoldableEvent[] = [
      { ts: "2026-07-14T00:05:00.000Z", hookEventName: "PreToolUse", eventObj: {} },
      { ts: "2026-07-14T00:00:00.000Z", hookEventName: "SessionStart", eventObj: {} },
      { ts: "2026-07-14T00:02:00.000Z", hookEventName: "PostToolUse", eventObj: {} },
    ];
    const delta = foldSessionFacets(events);
    expect(delta.minTs).toBe("2026-07-14T00:00:00.000Z");
    expect(delta.maxTs).toBe("2026-07-14T00:05:00.000Z");
  });

  it("throws for an empty batch — the engine never folds a session with zero new events", () => {
    expect(() => foldSessionFacets([])).toThrow();
  });
});
