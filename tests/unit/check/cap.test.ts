import { describe, it, expect } from "vitest";
import { capOutput, CHECK_OUTPUT_CAP_BYTES } from "../../../src/check/cap.js";

describe("capOutput", () => {
  it("stores output at the cap whole, truncated false", () => {
    const raw = "x".repeat(CHECK_OUTPUT_CAP_BYTES);
    const result = capOutput(raw);
    expect(result.output).toBe(raw);
    expect(result.truncated).toBe(false);
  });

  it("stores output under the cap whole, truncated false", () => {
    const raw = "under-cap-output";
    const result = capOutput(raw);
    expect(result.output).toBe(raw);
    expect(result.truncated).toBe(false);
  });

  it("truncates ASCII output over the cap to exactly the cap, flagged truncated", () => {
    const raw = "x".repeat(CHECK_OUTPUT_CAP_BYTES + 10);
    const result = capOutput(raw);
    expect(result.output).toBe("x".repeat(CHECK_OUTPUT_CAP_BYTES));
    expect(Buffer.byteLength(result.output, "utf8")).toBe(CHECK_OUTPUT_CAP_BYTES);
    expect(result.truncated).toBe(true);
  });

  it("backs off to the last whole codepoint when a multi-byte character straddles the cap boundary", () => {
    // 'x' + 'é'.repeat(16384) is 1 + 2*16384 = 32769 bytes -- one byte over
    // the cap, with the LAST byte of the cap window landing on the first
    // byte of a 2-byte 'é'. The cut must back off before that whole
    // character, never split it.
    const REPEAT = 16384;
    const raw = "x" + "é".repeat(REPEAT);
    const result = capOutput(raw);
    const expected = "x" + "é".repeat(REPEAT - 1);
    expect(result.output).toBe(expected);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(CHECK_OUTPUT_CAP_BYTES);
    expect(result.truncated).toBe(true);
  });

  it("never splits a codepoint even when the boundary byte itself starts a new character", () => {
    // 'é'.repeat(16384) is exactly 32768 bytes -- AT the cap, not over it.
    const atCap = "é".repeat(16384);
    const result = capOutput(atCap);
    expect(result.output).toBe(atCap);
    expect(result.truncated).toBe(false);

    // One more character pushes it one whole codepoint over the cap; the
    // cut must land exactly at the prior codepoint boundary (32768 bytes),
    // never mid-character.
    const overByOneChar = atCap + "é";
    const overResult = capOutput(overByOneChar);
    expect(overResult.output).toBe(atCap);
    expect(overResult.truncated).toBe(true);
  });
});
