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

  // F120 (ISS-0017 round-2 review): malformed argv before `--` used to be
  // silently swallowed -- `--session` with no value recorded a standalone
  // check with no error at all, and `--sesion` (typo) silently dropped
  // BOTH the flag and its id, after which rule-2 binding could attach the
  // check to a session the user never named, frozen into the spool forever
  // (the spool is ground truth, never re-resolved). Every token before `--`
  // is either the name (position 0) or a recognized `--session <id>` pair;
  // anything else is a usage error: exit nonzero, write nothing.

  it("is a usage error when --session has no value (end of args before --)", () => {
    const result = parseCheckArgv(["unit-pass", "--session", "--", "node", "-e", "1"]);
    expect(result.ok).toBe(false);
  });

  it("is a usage error when --session is the very last token before --, with nothing after it", () => {
    const result = parseCheckArgv(["unit-pass", "--session"]);
    expect(result.ok).toBe(false);
  });

  it("is a usage error on an unrecognized token before -- (a typo'd flag)", () => {
    const result = parseCheckArgv(["unit-pass", "--sesion", "abc", "--", "node", "-e", "1"]);
    expect(result.ok).toBe(false);
  });

  it("is a usage error on any unrecognized extra token before -- even if well-formed otherwise", () => {
    const result = parseCheckArgv(["unit-pass", "extra-token", "--", "node", "-e", "1"]);
    expect(result.ok).toBe(false);
  });

  it("still parses the valid --session <id> path (no regression)", () => {
    const result = parseCheckArgv(["unit-pass", "--session", "sess-1", "--", "node", "-e", "1"]);
    expect(result).toEqual({ ok: true, name: "unit-pass", session: "sess-1", command: ["node", "-e", "1"] });
  });
});
