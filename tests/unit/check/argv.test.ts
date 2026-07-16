import { describe, it, expect } from "vitest";
import { parseCheckArgv } from "../../../src/check/argv.js";

describe("parseCheckArgv", () => {
  it("parses name and wrapped command", () => {
    const result = parseCheckArgv(["unit-pass", "--", "node", "-e", "1"]);
    expect(result).toEqual({ ok: true, name: "unit-pass", command: ["node", "-e", "1"] });
  });

  it("parses an explicit --session before --", () => {
    const result = parseCheckArgv(["bind-explicit", "--session", "sess-123", "--", "node", "-e", "1"]);
    expect(result).toEqual({
      ok: true,
      name: "bind-explicit",
      session: "sess-123",
      command: ["node", "-e", "1"],
    });
  });

  it("is a usage error when -- is missing", () => {
    const result = parseCheckArgv(["unit-pass", "node", "-e", "1"]);
    expect(result.ok).toBe(false);
  });

  it("is a usage error when the wrapped command is empty", () => {
    const result = parseCheckArgv(["unit-pass", "--"]);
    expect(result.ok).toBe(false);
  });

  it("is a usage error when the name is missing", () => {
    const result = parseCheckArgv(["--", "node", "-e", "1"]);
    expect(result.ok).toBe(false);
  });

  it("treats everything after the FIRST -- as the wrapped command, including a literal --", () => {
    const result = parseCheckArgv(["unit-pass", "--", "node", "-e", "--", "1"]);
    expect(result).toEqual({ ok: true, name: "unit-pass", command: ["node", "-e", "--", "1"] });
  });
});
