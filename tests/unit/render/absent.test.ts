import { describe, it, expect } from "vitest";
import { ABSENT_MARKER, renderAbsent } from "../../../src/render/absent.js";

describe("renderAbsent", () => {
  it("renders the shared marker for null", () => {
    expect(renderAbsent(null)).toBe(ABSENT_MARKER);
  });

  it("renders the shared marker for undefined", () => {
    expect(renderAbsent(undefined)).toBe(ABSENT_MARKER);
  });

  it("renders the shared marker for an empty string (never confused with a genuine empty value)", () => {
    expect(renderAbsent("")).toBe(ABSENT_MARKER);
  });

  it("passes a genuine value through unchanged", () => {
    expect(renderAbsent("abc123")).toBe("abc123");
  });

  it("the marker is distinguishable from empty, zero and success tokens", () => {
    expect(ABSENT_MARKER).not.toBe("");
    expect(ABSENT_MARKER).not.toBe("0");
    expect(ABSENT_MARKER.toLowerCase()).not.toContain("success");
  });
});
