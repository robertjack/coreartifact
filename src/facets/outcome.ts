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

// An IN-FLIGHT command: a Bash PreToolUse with no paired Post event in the
// session — the session died (SIGKILL) while the command was running, and
// PreToolUse is subscribed precisely so this command stays visible
// (docs/issues/ISS-0005.md R1 rationale; integration-review S2, 2026-07-15:
// show folded every Pre away unconditionally, so the dying command
// vanished). Its outcome was never observed → ABSENT, never fabricated.
export function deriveInFlightCommandFacet(payload: Record<string, unknown>): CommandFacet {
  return { command: extractCommand(payload), durationMs: null, outcome: { state: "absent" } };
}

// Derives the three-state outcome, command string and duration for one Bash
// PostToolUse/PostToolUseFailure event. Never called for a bare PreToolUse:
// a PAIRED Pre is folded away (its Post renders the command's one line);
// an UNPAIRED Pre renders via deriveInFlightCommandFacet above.
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

// ISS-0024 R14: the backgrounded-outcome join. Ingest's promotion step (the
// only writer of the ledger's `events.background_task_id` column) reads
// this same value from ONE of two payload locations, normalized:
//   - the backgrounding PostToolUse: tool_response.backgroundTaskId
//   - a later PostToolUse of the TaskOutput tool: tool_input.task_id
// Both are register entries (undocumented tool + response shape) — any
// shape surprise (missing/non-string fields) degrades to null, never
// throws. Gated to PostToolUse only (spec: "The backgrounding PostToolUse
// carries... a later PostToolUse of the TaskOutput tool carries...") so a
// PreToolUse(TaskOutput) poll attempt (which also carries tool_input.task_id
// but no resolved outcome yet) never pollutes the join key.
export function extractBackgroundTaskId(hookEventName: string, payload: Record<string, unknown>): string | null {
  if (hookEventName !== "PostToolUse") return null;

  const toolResponse = asObject(payload.tool_response);
  const backgroundTaskId = toolResponse ? toolResponse.backgroundTaskId : undefined;
  if (typeof backgroundTaskId === "string" && backgroundTaskId.length > 0) return backgroundTaskId;

  if (payload.tool_name === "TaskOutput") {
    const toolInput = asObject(payload.tool_input);
    const taskId = toolInput ? toolInput.task_id : undefined;
    if (typeof taskId === "string" && taskId.length > 0) return taskId;
  }

  return null;
}

export interface BackgroundJoinCandidate {
  backgroundTaskId: string | null;
  payload: Record<string, unknown>;
}

// The join itself: pure derivation over already-loaded session events, no
// stored outcome column, no spool mutation (spec "The backgrounded-outcome
// join (R14)"). Scans for a PostToolUse(TaskOutput) event sharing the
// backgrounding event's task id whose tool_response.task.exitCode resolved
// as a number: 0 -> success, nonzero -> failure. An in-flight poll (task
// present but exitCode null/missing, e.g. status "running") does not count
// as a match — the scan keeps looking. No resolving match anywhere in the
// session (no poll before session end, a crash, or a hostile/malformed
// task shape) -> absent, honestly. Never throws.
export function deriveBackgroundedOutcome(
  targetTaskId: string,
  candidates: BackgroundJoinCandidate[],
): Outcome {
  for (const candidate of candidates) {
    if (candidate.backgroundTaskId !== targetTaskId) continue;
    if (candidate.payload.tool_name !== "TaskOutput") continue;
    const toolResponse = asObject(candidate.payload.tool_response);
    const task = toolResponse ? asObject(toolResponse.task) : null;
    const exitCode = task ? numberOrNull(task.exitCode) : null;
    if (exitCode === null) continue;
    return exitCode === 0 ? { state: "success" } : { state: "failure", error: "" };
  }
  return { state: "absent" };
}
