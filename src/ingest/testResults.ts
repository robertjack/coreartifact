// Payload extraction for the parser interface (docs/issues/ISS-0018.md "The
// two payload paths"). Ingest owns extraction; parsers stay trivially
// unit-testable over plain captured text and never see a raw hook payload.
//
// A passing run lands in PostToolUse at tool_response.stdout; a failing run
// lands as PostToolUseFailure — which carries NO tool_response — with the
// whole vitest output embedded in the `error` string after the
// "Exit code 1\n\n" marker. Both paths hand the parser plain text plus the
// exit code the event shape itself implies.
import type { Parser, TestResults } from "../parsers/types.js";
import { parseVitest } from "../parsers/vitest.js";

// The hardcoded parser list — no registry, no config (spec: "there is no
// parser registry or config — the set is hardcoded"). Order matters only in
// that the first non-null result wins; today there is exactly one.
export const PARSERS: ReadonlyArray<{ name: string; parse: Parser }> = [{ name: "vitest", parse: parseVitest }];

export interface ExtractedCommandOutput {
  command: string | null;
  stdout: string;
  stderr: string;
  exit: number;
}

const FAILURE_MARKER = "Exit code 1\n\n";

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Extracts the (command, stdout, stderr, exit) tuple a parser needs from one
// already-decoded command event's payload — or null when the event shape
// carries no output a parser could ever claim (not a Bash tool event, not a
// Post/PostFailure event, or a PostToolUseFailure with no error string).
export function extractCommandOutput(
  hookEventName: string,
  payload: Record<string, unknown>,
): ExtractedCommandOutput | null {
  if (payload.tool_name !== "Bash") return null;

  const toolInput = asObject(payload.tool_input);
  const command = toolInput && typeof toolInput.command === "string" ? toolInput.command : null;

  if (hookEventName === "PostToolUseFailure") {
    const error = payload.error;
    if (typeof error !== "string") return null;
    const stdout = error.startsWith(FAILURE_MARKER) ? error.slice(FAILURE_MARKER.length) : error;
    return { command, stdout, stderr: "", exit: 1 };
  }

  if (hookEventName === "PostToolUse") {
    const toolResponse = asObject(payload.tool_response);
    return {
      command,
      stdout: toolResponse ? stringOrEmpty(toolResponse.stdout) : "",
      stderr: toolResponse ? stringOrEmpty(toolResponse.stderr) : "",
      exit: 0,
    };
  }

  return null;
}

// Runs the hardcoded parser list over one extracted command's output,
// returning the first claim (name + result) or null when no parser claims
// it — a non-test command is not a degraded facet (schema.md).
export function claimTestResults(output: ExtractedCommandOutput): { parser: string; result: TestResults } | null {
  for (const { name, parse } of PARSERS) {
    const result = parse(output.command, output.stdout, output.stderr, output.exit);
    if (result !== null) return { parser: name, result };
  }
  return null;
}
