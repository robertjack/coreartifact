// Footprint derivation (pure) — the distinct file paths touched via
// file-editing tool events in a session (docs/issues/ISS-0006.md "Facets and
// the degradation law"). Bash side-effects on files are deliberately NOT
// footprint in v1: only these named tool names count, no matter what a
// Bash command's argv textually touches.
//
// Operates on already-decoded event objects (the shape of a spool line's
// `event` member once JSON.parse'd) rather than raw payload text, so the
// engine and unit tests share one decode step.

const FOOTPRINT_TOOL_NAMES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export interface FootprintCandidateEvent {
  tool_name?: unknown;
  tool_input?: unknown;
}

// Returns the touched file path for one event, or null when the event is
// not a file-editing tool event (wrong tool_name, or no string
// tool_input.file_path — e.g. a Bash command, or a malformed payload).
export function extractFootprintPath(event: FootprintCandidateEvent): string | null {
  if (typeof event.tool_name !== "string" || !FOOTPRINT_TOOL_NAMES.has(event.tool_name)) return null;
  if (typeof event.tool_input !== "object" || event.tool_input === null || Array.isArray(event.tool_input)) {
    return null;
  }
  const filePath = (event.tool_input as Record<string, unknown>).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : null;
}

// Distinct file paths across a list of events, in first-seen order — a pure
// set derivation with no duplicate rows for a path touched more than once
// (e.g. Written then Edited).
export function deriveFootprintPaths(events: FootprintCandidateEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    const path = extractFootprintPath(event);
    if (path !== null) seen.add(path);
  }
  return [...seen];
}
