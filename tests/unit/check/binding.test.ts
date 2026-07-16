import { describe, it, expect } from "vitest";
import { resolveBinding } from "../../../src/check/binding.js";

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
