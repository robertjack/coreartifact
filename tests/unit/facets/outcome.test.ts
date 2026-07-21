// Unit tests for the outcome derivation module (docs/issues/ISS-0008.md
// "Below-the-seam unit tests"): three payload signatures, three states, no
// overlap. Below the seam — pure logic, no ledger, no CLI subprocess.
import { describe, it, expect } from "vitest";
import {
  deriveCommandFacet,
  isBashToolPayload,
  extractBackgroundTaskId,
  deriveBackgroundedOutcome,
  type BackgroundJoinCandidate,
} from "../../../src/facets/outcome.js";

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

// ISS-0024 R14: the ingest-side promotion of events.background_task_id from
// one of two payload locations.
describe("facets/outcome: extractBackgroundTaskId", () => {
  it("promotes the backgrounding PostToolUse's tool_response.backgroundTaskId", () => {
    expect(
      extractBackgroundTaskId("PostToolUse", {
        tool_name: "Bash",
        tool_response: { backgroundTaskId: "task-abc" },
      }),
    ).toBe("task-abc");
  });

  it("promotes a PostToolUse(TaskOutput) event's tool_input.task_id", () => {
    expect(
      extractBackgroundTaskId("PostToolUse", {
        tool_name: "TaskOutput",
        tool_input: { task_id: "task-abc" },
        tool_response: { retrieval_status: "success", task: { task_id: "task-abc", exitCode: 0 } },
      }),
    ).toBe("task-abc");
  });

  it("is null for a PreToolUse(TaskOutput) poll attempt — no resolved outcome yet, must never pollute the join key", () => {
    expect(
      extractBackgroundTaskId("PreToolUse", {
        tool_name: "TaskOutput",
        tool_input: { task_id: "task-abc" },
      }),
    ).toBeNull();
  });

  it("is null for an ordinary Bash PostToolUse with no backgroundTaskId", () => {
    expect(
      extractBackgroundTaskId("PostToolUse", {
        tool_name: "Bash",
        tool_response: { stdout: "ok" },
      }),
    ).toBeNull();
  });

  it("is null for a non-string/empty backgroundTaskId (hostile shape), never fabricated", () => {
    expect(
      extractBackgroundTaskId("PostToolUse", { tool_name: "Bash", tool_response: { backgroundTaskId: 42 } }),
    ).toBeNull();
    expect(
      extractBackgroundTaskId("PostToolUse", { tool_name: "Bash", tool_response: { backgroundTaskId: "" } }),
    ).toBeNull();
    expect(extractBackgroundTaskId("PostToolUse", { tool_name: "Bash" })).toBeNull();
  });
});

// ISS-0024 R14: the join derivation itself, over an in-memory candidate set.
describe("facets/outcome: deriveBackgroundedOutcome", () => {
  const matchedZero: BackgroundJoinCandidate = {
    backgroundTaskId: "task-abc",
    payload: { tool_name: "TaskOutput", tool_response: { task: { exitCode: 0 } } },
  };
  const matchedNonzero: BackgroundJoinCandidate = {
    backgroundTaskId: "task-abc",
    payload: { tool_name: "TaskOutput", tool_response: { task: { exitCode: 1 } } },
  };
  const inFlightPoll: BackgroundJoinCandidate = {
    backgroundTaskId: "task-abc",
    payload: { tool_name: "TaskOutput", tool_response: { task: { status: "running", exitCode: null } } },
  };
  const unrelatedTask: BackgroundJoinCandidate = {
    backgroundTaskId: "task-xyz",
    payload: { tool_name: "TaskOutput", tool_response: { task: { exitCode: 0 } } },
  };

  it("a matched TaskOutput with exitCode 0 resolves to success", () => {
    expect(deriveBackgroundedOutcome("task-abc", [matchedZero])).toEqual({ state: "success" });
  });

  it("a matched TaskOutput with a nonzero exitCode resolves to failure, naming the exit code (F141: the joined outcome must not drop it)", () => {
    expect(deriveBackgroundedOutcome("task-abc", [matchedNonzero])).toEqual({
      state: "failure",
      error: "Exit code 1",
    });
  });

  it("no matching TaskOutput anywhere in the session resolves to absent, never a guess", () => {
    expect(deriveBackgroundedOutcome("task-abc", [unrelatedTask])).toEqual({ state: "absent" });
    expect(deriveBackgroundedOutcome("task-abc", [])).toEqual({ state: "absent" });
  });

  it("an in-flight poll (task present, exitCode still null) does not count as a match — keeps scanning, falls through to absent", () => {
    expect(deriveBackgroundedOutcome("task-abc", [inFlightPoll])).toEqual({ state: "absent" });
  });

  it("an in-flight poll followed by the completed poll still resolves, in either recorded order", () => {
    expect(deriveBackgroundedOutcome("task-abc", [inFlightPoll, matchedZero])).toEqual({ state: "success" });
  });

  it("hostile task shapes (missing tool_response, missing task, non-number exitCode, non-TaskOutput tool) degrade to absent, never throw", () => {
    const candidates: BackgroundJoinCandidate[] = [
      { backgroundTaskId: "task-abc", payload: { tool_name: "TaskOutput" } },
      { backgroundTaskId: "task-abc", payload: { tool_name: "TaskOutput", tool_response: {} } },
      { backgroundTaskId: "task-abc", payload: { tool_name: "TaskOutput", tool_response: { task: {} } } },
      {
        backgroundTaskId: "task-abc",
        payload: { tool_name: "TaskOutput", tool_response: { task: { exitCode: "0" } } },
      },
      { backgroundTaskId: "task-abc", payload: { tool_name: "Bash", tool_response: { task: { exitCode: 0 } } } },
    ];
    expect(() => deriveBackgroundedOutcome("task-abc", candidates)).not.toThrow();
    expect(deriveBackgroundedOutcome("task-abc", candidates)).toEqual({ state: "absent" });
  });
});
