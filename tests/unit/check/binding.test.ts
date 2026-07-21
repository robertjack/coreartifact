import { describe, it, expect } from "vitest";
import { resolveBinding, renderSingleOpenBindingNotice } from "../../../src/check/binding.js";

describe("resolveBinding", () => {
  it("binds standalone (null, null) with zero open sessions", () => {
    const result = resolveBinding({ openSessionIds: [], knownSessionIds: new Set() });
    expect(result).toEqual({ ok: true, sessionId: null, boundBy: null });
  });

  it("binds to the single open session", () => {
    const result = resolveBinding({
      openSessionIds: ["sess-a"],
      knownSessionIds: new Set(["sess-a"]),
    });
    expect(result).toEqual({ ok: true, sessionId: "sess-a", boundBy: "single-open" });
  });

  it("binds standalone (null, null) with several open sessions -- never a guess", () => {
    const result = resolveBinding({
      openSessionIds: ["sess-a", "sess-b"],
      knownSessionIds: new Set(["sess-a", "sess-b"]),
    });
    expect(result).toEqual({ ok: true, sessionId: null, boundBy: null });
  });

  it("an explicit --session always wins, even over several open sessions", () => {
    const result = resolveBinding({
      explicitSessionId: "sess-b",
      openSessionIds: ["sess-a", "sess-b"],
      knownSessionIds: new Set(["sess-a", "sess-b"]),
    });
    expect(result).toEqual({ ok: true, sessionId: "sess-b", boundBy: "explicit" });
  });

  it("an explicit --session wins even when zero sessions are open", () => {
    const result = resolveBinding({
      explicitSessionId: "sess-closed",
      openSessionIds: [],
      knownSessionIds: new Set(["sess-closed"]),
    });
    expect(result).toEqual({ ok: true, sessionId: "sess-closed", boundBy: "explicit" });
  });

  it("an unknown --session id is a typed failure naming the id, never a guess", () => {
    const result = resolveBinding({
      explicitSessionId: "sess-ghost",
      openSessionIds: ["sess-a"],
      knownSessionIds: new Set(["sess-a"]),
    });
    expect(result).toEqual({ ok: false, unknownSessionId: "sess-ghost" });
  });
});

// 2026-07-21 dogfood finding: the single-open fallback attributed a
// human-run check to the open agent session with nothing printed at run
// time. The notice is the bind-time half of the fix (the render half lives
// in src/render/show.ts / log.ts) — pure string, tested at the same
// no-I/O seam as resolveBinding.
describe("renderSingleOpenBindingNotice", () => {
  it("names the auto-bound session, the single-open mode, and the explicit alternative", () => {
    const notice = renderSingleOpenBindingNotice("sess-a");
    expect(notice).toContain("sess-a");
    expect(notice).toContain("single-open");
    expect(notice).toContain("--session");
  });
});
