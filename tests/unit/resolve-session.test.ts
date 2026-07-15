// Unit tests for the PURE session-resolution logic (ISS-0012). No I/O, no
// registry, no SQLite — exercises classifySessionMatch directly against a
// hand-built candidate list, per the spec's "Test-harness contract": exact
// match, unique prefix, ambiguous, too-short, unknown.
import { describe, it, expect } from "vitest";
import {
  classifySessionMatch,
  MIN_SESSION_PREFIX_LENGTH,
  type SessionCandidate,
} from "../../src/resolve-session.js";

const FULL_ID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const FULL_ID_B = "bbbbbbbb-1111-2222-3333-444444444444";

function candidate(sessionId: string, repoRoot: string): SessionCandidate {
  return { sessionId, repoRoot };
}

describe("classifySessionMatch", () => {
  it("resolves an exact full session id to the one repo that has it", () => {
    const result = classifySessionMatch(FULL_ID_A, [
      candidate(FULL_ID_A, "/repo/a"),
      candidate(FULL_ID_B, "/repo/b"),
    ]);
    expect(result).toEqual({ kind: "found", sessionId: FULL_ID_A, repoRoot: "/repo/a" });
  });

  it("resolves a unique prefix (log's short-id length) to its one match", () => {
    const shortId = FULL_ID_A.slice(0, 8);
    expect(shortId.length).toBe(MIN_SESSION_PREFIX_LENGTH);
    const result = classifySessionMatch(shortId, [
      candidate(FULL_ID_A, "/repo/a"),
      candidate(FULL_ID_B, "/repo/b"),
    ]);
    expect(result).toEqual({ kind: "found", sessionId: FULL_ID_A, repoRoot: "/repo/a" });
  });

  it("resolves a longer-than-short prefix uniquely too", () => {
    const longerPrefix = FULL_ID_A.slice(0, 20);
    const result = classifySessionMatch(longerPrefix, [
      candidate(FULL_ID_A, "/repo/a"),
      candidate(FULL_ID_B, "/repo/b"),
    ]);
    expect(result).toEqual({ kind: "found", sessionId: FULL_ID_A, repoRoot: "/repo/a" });
  });

  it("fails honestly when a prefix matches more than one session across the union", () => {
    const sharedPrefixId1 = "cccccccc-0000-0000-0000-000000000001";
    const sharedPrefixId2 = "cccccccc-0000-0000-0000-000000000002";
    const ambiguousPrefix = "cccccccc";
    const result = classifySessionMatch(ambiguousPrefix, [
      candidate(sharedPrefixId1, "/repo/a"),
      candidate(sharedPrefixId2, "/repo/b"),
    ]);
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.repoRoot).sort()).toEqual(["/repo/a", "/repo/b"]);
  });

  it("fails honestly when the SAME session id is present in two repos' ledgers (an exact full-id match, still ambiguous)", () => {
    const result = classifySessionMatch(FULL_ID_A, [
      candidate(FULL_ID_A, "/repo/a"),
      candidate(FULL_ID_A, "/repo/b"),
    ]);
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates.map((c) => c.repoRoot).sort()).toEqual(["/repo/a", "/repo/b"]);
  });

  it("reports not-found for an unknown full id", () => {
    const unknown = "00000000-0000-0000-0000-000000000000";
    const result = classifySessionMatch(unknown, [candidate(FULL_ID_A, "/repo/a")]);
    expect(result).toEqual({ kind: "not-found", sessionArg: unknown });
  });

  it("reports not-found for an unknown prefix at the minimum length", () => {
    const unknownPrefix = "z".repeat(MIN_SESSION_PREFIX_LENGTH);
    const result = classifySessionMatch(unknownPrefix, [candidate(FULL_ID_A, "/repo/a")]);
    expect(result).toEqual({ kind: "not-found", sessionArg: unknownPrefix });
  });

  it("rejects a prefix shorter than MIN_SESSION_PREFIX_LENGTH as a usage error, never a match-everything wildcard", () => {
    const tooShort = FULL_ID_A.slice(0, MIN_SESSION_PREFIX_LENGTH - 1);
    const result = classifySessionMatch(tooShort, [
      candidate(FULL_ID_A, "/repo/a"),
      candidate(FULL_ID_B, "/repo/b"),
    ]);
    expect(result.kind).toBe("usage-error");
    if (result.kind !== "usage-error") throw new Error("unreachable");
    expect(result.message).toMatch(/usage/i);
  });

  it("rejects an empty string as a usage error, never a match-everything wildcard", () => {
    const result = classifySessionMatch("", [
      candidate(FULL_ID_A, "/repo/a"),
      candidate(FULL_ID_B, "/repo/b"),
    ]);
    expect(result.kind).toBe("usage-error");
  });

  it("never treats an empty prefix as matching every candidate (mutation check on the length guard)", () => {
    // If the too-short guard were removed, "" would match every session via
    // startsWith("") — this is the exact phantom-match bug class the spec
    // names. Asserting not-found/usage-error rather than found across a
    // multi-candidate list is the check that would go red if that guard
    // were deleted.
    const result = classifySessionMatch("", [
      candidate(FULL_ID_A, "/repo/a"),
      candidate(FULL_ID_B, "/repo/b"),
    ]);
    expect(result.kind).not.toBe("found");
    expect(result.kind).not.toBe("ambiguous");
  });
});
