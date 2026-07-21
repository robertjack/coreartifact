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

// The resumed-session shape, observed live 2026-07-20 (this repo's own
// spool, session ecb416c0): a SECOND SessionStart with source "resume", no
// `model` key, and a fresh git.head — falsifying the fold's original
// "SessionStart occurs at most once" assumption. Every facet must be
// first-non-null-wins, mirroring the incremental upsert's COALESCE merge,
// or a full rebuild diverges from the incrementally grown ledger (the
// rebuild law violated — found by the 2026-07-20 pre-launch audit).
describe("foldSessionFacets: resumed sessions (multiple boundary lines)", () => {
  const resumedSession: FoldableEvent[] = [
    {
      ts: "2026-07-20T17:46:11.000Z",
      hookEventName: "SessionStart",
      eventObj: { model: "claude-fable-5", source: "startup" },
      git: { head: "aaaa000000000000000000000000000000000001" },
    },
    { ts: "2026-07-20T18:00:00.000Z", hookEventName: "PostToolUse", eventObj: {} },
    {
      ts: "2026-07-20T19:00:00.000Z",
      hookEventName: "SessionStart",
      eventObj: { source: "resume" },
      git: { head: "bbbb000000000000000000000000000000000002" },
    },
  ];

  it("sha_before is the FIRST SessionStart's head — the resume line never overwrites it", () => {
    expect(foldSessionFacets(resumedSession).shaBefore).toBe("aaaa000000000000000000000000000000000001");
  });

  it("kind contribution is the FIRST SessionStart's — the model-less resume line never demotes it", () => {
    expect(foldSessionFacets(resumedSession).kind).toBe("interactive");
  });

  it("a facet the first boundary line lacks is still taken from a later one (COALESCE semantics, per-facet not per-event)", () => {
    const headlessNoHeadThenResume: FoldableEvent[] = [
      { ts: "2026-07-20T17:00:00.000Z", hookEventName: "SessionStart", eventObj: { source: "startup" } },
      {
        ts: "2026-07-20T18:00:00.000Z",
        hookEventName: "SessionStart",
        eventObj: { source: "resume" },
        git: { head: "cccc000000000000000000000000000000000003" },
      },
    ];
    const delta = foldSessionFacets(headlessNoHeadThenResume);
    expect(delta.kind).toBe("headless");
    expect(delta.shaBefore).toBe("cccc000000000000000000000000000000000003");
  });

  it("ended_at and sha_after are first-wins across multiple SessionEnds, matching the incremental merge exactly", () => {
    const doubleEnd: FoldableEvent[] = [
      ...resumedSession,
      {
        ts: "2026-07-20T18:30:00.000Z",
        hookEventName: "SessionEnd",
        eventObj: { reason: "clear" },
        git: { head: "dddd000000000000000000000000000000000004" },
      },
      {
        ts: "2026-07-20T20:00:00.000Z",
        hookEventName: "SessionEnd",
        eventObj: { reason: "other" },
        git: { head: "eeee000000000000000000000000000000000005" },
      },
    ];
    const delta = foldSessionFacets(doubleEnd);
    expect(delta.endedAt).toBe("2026-07-20T18:30:00.000Z");
    expect(delta.shaAfter).toBe("dddd000000000000000000000000000000000004");
    expect(delta.maxTs).toBe("2026-07-20T20:00:00.000Z");
  });
});
