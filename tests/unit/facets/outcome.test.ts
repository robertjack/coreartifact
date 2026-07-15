// Unit tests for the outcome derivation module (docs/issues/ISS-0008.md
// "Below-the-seam unit tests"): three payload signatures, three states, no
// overlap. Below the seam — pure logic, no ledger, no CLI subprocess.
import { describe, it, expect } from "vitest";
import { deriveCommandFacet, isBashToolPayload } from "../../../src/facets/outcome.js";

describe("facets/outcome: deriveCommandFacet", () => {
  it("a plain Bash PostToolUse (no backgroundTaskId) derives success", () => {
    const facet = deriveCommandFacet({
      hookEventName: "PostToolUse",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "echo capture-ok" },
        tool_response: { stdout: "capture-ok", stderr: "" },
        duration_ms: 165,
      },
    });
    expect(facet.outcome).toEqual({ state: "success" });
    expect(facet.command).toBe("echo capture-ok");
    expect(facet.durationMs).toBe(165);
  });

  it("a PostToolUseFailure derives failure with the error preserved verbatim", () => {
    const error = "Exit code 1\n[bat error]: '/nonexistent-file-for-recording': No such file or directory (os error 2)";
    const facet = deriveCommandFacet({
      hookEventName: "PostToolUseFailure",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "cat /nonexistent-file-for-recording" },
        error,
        duration_ms: 19,
      },
    });
    expect(facet.outcome).toEqual({ state: "failure", error });
    expect(facet.command).toBe("cat /nonexistent-file-for-recording");
    expect(facet.durationMs).toBe(19);
  });

  it("a PostToolUse whose tool_response carries a backgroundTaskId derives ABSENT, not success", () => {
    const facet = deriveCommandFacet({
      hookEventName: "PostToolUse",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "sleep 90" },
        tool_response: { stdout: "", stderr: "", backgroundTaskId: "bzc1n4ebp" },
        duration_ms: 3,
      },
    });
    expect(facet.outcome).toEqual({ state: "absent" });
  });

  it("the three signatures never overlap: backgroundTaskId beats a would-be success, PostToolUseFailure never reads tool_response", () => {
    const failureFacet = deriveCommandFacet({
      hookEventName: "PostToolUseFailure",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "false" },
        // PostToolUseFailure carries no tool_response (spec) — even if one
        // were present, the failure signature must win.
        tool_response: { backgroundTaskId: "should-not-matter" },
        error: "Exit code 1",
      },
    });
    expect(failureFacet.outcome.state).toBe("failure");
  });

  it("a missing duration_ms or command degrades to null, never a fabricated value", () => {
    const facet = deriveCommandFacet({
      hookEventName: "PostToolUse",
      payload: { tool_name: "Bash", tool_response: {} },
    });
    expect(facet.command).toBeNull();
    expect(facet.durationMs).toBeNull();
    expect(facet.outcome).toEqual({ state: "success" });
  });
});

describe("facets/outcome: isBashToolPayload", () => {
  it("is true only for tool_name Bash", () => {
    expect(isBashToolPayload({ tool_name: "Bash" })).toBe(true);
    expect(isBashToolPayload({ tool_name: "Write" })).toBe(false);
    expect(isBashToolPayload({})).toBe(false);
  });
});
