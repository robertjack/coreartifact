// Facet derivation — command string, outcome and duration are NOT ledger
// columns; they are read from `events.payload` (the verbatim hook payload)
// at render time (docs/issues/ISS-0008.md "Facets are derived at render").
//
// The three-state outcome is the heart of this issue and must never
// collapse into two states:
//   - success — PostToolUse on a Bash command, no failure marker.
//   - failure — PostToolUseFailure; its `error` string is preserved
//     verbatim (embeds "Exit code N" plus the message). PostToolUseFailure
//     carries no `tool_response` — this module never reads one for it.
//   - absent  — an auto-backgrounded command: PostToolUse whose
//     tool_response carries a backgroundTaskId with no exit outcome. Final:
//     there is no reaction to backgrounded-command completion this
//     campaign (PRD-0002). Never optimistically rendered as success — that
//     would manufacture a false receipt.

export type Outcome =
  | { state: "success" }
  | { state: "failure"; error: string }
  | { state: "absent" };

export interface CommandFacetInput {
  hookEventName: string;
  payload: Record<string, unknown>;
}

export interface CommandFacet {
  command: string | null;
  durationMs: number | null;
  outcome: Outcome;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Bash command string — observed only on `tool_input.command`, present on
// PreToolUse, PostToolUse and PostToolUseFailure alike.
function extractCommand(payload: Record<string, unknown>): string | null {
  const toolInput = asObject(payload.tool_input);
  return toolInput ? stringOrNull(toolInput.command) : null;
}

// Whether an event's payload names the Bash tool — the gate for "every
// command" in the spec; a non-Bash PreToolUse/PostToolUse is a plain
// lifecycle line, not a command line.
export function isBashToolPayload(payload: Record<string, unknown>): boolean {
  return payload.tool_name === "Bash";
}

// PostToolUse's own signature for "this command was auto-backgrounded":
// tool_response.backgroundTaskId, with no exit outcome ever observed
// alongside it (spec: "a long Bash was auto-backgrounded, PostToolUse fired
// in 155ms with empty stdout").
function isAutoBackgrounded(payload: Record<string, unknown>): boolean {
  const toolResponse = asObject(payload.tool_response);
  const backgroundTaskId = toolResponse ? toolResponse.backgroundTaskId : undefined;
  return typeof backgroundTaskId === "string" && backgroundTaskId.length > 0;
}

// Derives the three-state outcome, command string and duration for one Bash
// PostToolUse/PostToolUseFailure event. Never called for a bare PreToolUse
// (which carries no outcome/duration of its own) — the caller folds
// PreToolUse away and renders the paired Post event instead.
export function deriveCommandFacet(input: CommandFacetInput): CommandFacet {
  const { hookEventName, payload } = input;
  const command = extractCommand(payload);
  const durationMs = numberOrNull(payload.duration_ms);

  if (hookEventName === "PostToolUseFailure") {
    return {
      command,
      durationMs,
      outcome: { state: "failure", error: stringOrNull(payload.error) ?? "" },
    };
  }

  if (isAutoBackgrounded(payload)) {
    return { command, durationMs, outcome: { state: "absent" } };
  }

  return { command, durationMs, outcome: { state: "success" } };
}
