// Unit tests for the ingest-side payload extraction (docs/issues/ISS-0018.md
// "The two payload paths"): marker stripping, and which event shapes feed
// the parser. Below the seam — pure logic over already-decoded payload
// objects, no ledger, no CLI subprocess.
//
// The passing/failing payload shapes are read through the fixtures loader
// (never pasted by hand) since the vitest fixture stream already carries
// recorded examples of both.
import { describe, it, expect } from "vitest";
import { extractCommandOutput, claimTestResults, PARSERS } from "../../../src/ingest/testResults.js";
import { loadFixtureStream } from "../../fixtures/loader.js";

function payloadAt(lines: string[], index: number): Record<string, unknown> {
  return JSON.parse(lines[index]!) as Record<string, unknown>;
}

describe("extractCommandOutput", () => {
  it("extracts stdout/exit 0 from a recorded PostToolUse (passing) event's tool_response", () => {
    const vitestLines = loadFixtureStream("vitest");
    const passing = payloadAt(vitestLines, 3);

    const output = extractCommandOutput("PostToolUse", passing);

    expect(output).not.toBeNull();
    expect(output!.command).toBe("pnpm vitest run passing.test.js");
    expect(output!.exit).toBe(0);
    expect(output!.stdout).toContain("Tests  2 passed (2)");
    expect(output!.stderr).toBe("");
  });

  it("strips the 'Exit code 1\\n\\n' marker from a recorded PostToolUseFailure event's error string and reports exit 1", () => {
    const vitestLines = loadFixtureStream("vitest");
    const failing = payloadAt(vitestLines, 5);
    expect(failing.tool_response).toBeUndefined();

    const output = extractCommandOutput("PostToolUseFailure", failing);

    expect(output).not.toBeNull();
    expect(output!.exit).toBe(1);
    expect(output!.stdout.startsWith("Exit code 1")).toBe(false);
    expect(output!.stdout).toContain("Tests  1 failed | 3 passed (4)");
  });

  it("returns null for a non-Bash tool event", () => {
    expect(
      extractCommandOutput("PostToolUse", {
        tool_name: "Write",
        tool_input: { file_path: "/a.txt" },
        tool_response: {},
      }),
    ).toBeNull();
  });

  it("returns null for a PostToolUseFailure with no error string", () => {
    expect(extractCommandOutput("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "x" } })).toBeNull();
  });

  it("returns null for event shapes that never carry test output (PreToolUse, lifecycle events)", () => {
    expect(
      extractCommandOutput("PreToolUse", { tool_name: "Bash", tool_input: { command: "pnpm vitest run" } }),
    ).toBeNull();
    expect(extractCommandOutput("SessionStart", {})).toBeNull();
  });
});

describe("claimTestResults", () => {
  it("returns the vitest parser's claim (name + result) for a claimed command", () => {
    const claim = claimTestResults({
      command: "pnpm vitest run passing.test.js",
      stdout: " Test Files  1 passed (1)\n      Tests  2 passed (2)\n   Duration  65ms (...)",
      stderr: "",
      exit: 0,
    });
    expect(claim).not.toBeNull();
    expect(claim!.parser).toBe("vitest");
    expect(claim!.result.passed).toBe(2);
  });

  it("returns null when no parser in the hardcoded list claims the command", () => {
    expect(claimTestResults({ command: "echo capture-ok", stdout: "capture-ok", stderr: "", exit: 0 })).toBeNull();
  });

  it("the parser list is exactly the vitest parser today (no registry, no config)", () => {
    expect(PARSERS.map((p) => p.name)).toEqual(["vitest"]);
  });
});
