import { describe, it, expect } from "vitest";
import { parseClaudeVersionOutput, TESTED_CLAUDE_CODE_RANGE } from "../../../src/doctor/version.js";

describe("parseClaudeVersionOutput", () => {
  it("parses the recorded output shape (2.1.211 (Claude Code))", () => {
    expect(parseClaudeVersionOutput("2.1.211 (Claude Code)")).toBe("2.1.211");
  });

  it("parses the recorded shape with a trailing newline (ordinary process framing)", () => {
    expect(parseClaudeVersionOutput("2.1.211 (Claude Code)\n")).toBe("2.1.211");
  });

  it("renders ABSENT (null) for multi-line output", () => {
    expect(parseClaudeVersionOutput("2.1.211 (Claude Code)\nsome extra line")).toBeNull();
  });

  it("renders ABSENT (null) for an empty string", () => {
    expect(parseClaudeVersionOutput("")).toBeNull();
  });

  it("renders ABSENT (null) for a non-semver first token", () => {
    expect(parseClaudeVersionOutput("not-a-version (Claude Code)")).toBeNull();
  });

  it("renders ABSENT (null) for a garbled token with no space before the suffix", () => {
    expect(parseClaudeVersionOutput("2.1.211(Claude Code)")).toBeNull();
  });

  it("renders ABSENT (null) for whitespace-only output", () => {
    expect(parseClaudeVersionOutput("   \n  \n")).toBeNull();
  });
});

describe("TESTED_CLAUDE_CODE_RANGE", () => {
  it("names the fixtures' actual span", () => {
    expect(TESTED_CLAUDE_CODE_RANGE.min).toBe("2.1.208");
    expect(TESTED_CLAUDE_CODE_RANGE.max).toBe("2.1.216");
  });
});

// Finding 138 (operator amendment 2026-07-20): a -prerelease/+build suffix
// is ordinary semver framing, not corruption — it must parse, not degrade
// the whole version facet to ABSENT.
describe("parseClaudeVersionOutput: suffixed semver (finding 138)", () => {
  it("accepts -prerelease and +build suffixes", () => {
    expect(parseClaudeVersionOutput("2.2.0-beta.1 (Claude Code)\n")).toBe("2.2.0-beta.1");
    expect(parseClaudeVersionOutput("2.1.216+build.7 (Claude Code)\n")).toBe("2.1.216+build.7");
  });
  it("still rejects genuinely malformed tokens", () => {
    expect(parseClaudeVersionOutput("v2.1.216 (Claude Code)\n")).toBeNull();
    expect(parseClaudeVersionOutput("2.1 (Claude Code)\n")).toBeNull();
  });
});
