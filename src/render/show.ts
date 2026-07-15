// The `show` renderer — a header (shas, footprint) followed by a flat
// chronological timeline (docs/issues/ISS-0008.md "What show prints"). Pure
// formatting only, same stance as src/render/log.ts: every field here is
// already computed by the caller (src/cli/commands/show.ts) from the
// ledger/facets; this module never touches SQLite or the spool.
//
// Flat, not a tree (spec): entries render in `seq` order with no indentation
// or grouping by agent_id — the nesting keys are carried on each entry but
// v1 never nests the presentation.
import { ABSENT_MARKER, renderAbsent } from "./absent.js";
import type { Outcome } from "../facets/outcome.js";

export interface ShowHeaderInput {
  sessionId: string;
  shaBefore: string | null;
  shaAfter: string | null;
  footprint: string[];
}

// Free text (a prompt, a verbatim error) can itself carry embedded newlines
// (observed: PostToolUseFailure's error is "Exit code 1\n<message>"). The
// error string must still be preserved verbatim (spec) while the timeline
// stays one physical line per entry — so embedded line breaks are rendered
// as a literal `\n` escape sequence rather than a raw byte, never dropped or
// summarized.
function toSingleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\\n");
}

export function renderShowHeader(input: ShowHeaderInput): string {
  const footprintText = input.footprint.length > 0 ? input.footprint.join(", ") : "(none)";
  return [
    `session:     ${input.sessionId}`,
    `sha_before:  ${renderAbsent(input.shaBefore)}`,
    `sha_after:   ${renderAbsent(input.shaAfter)}`,
    `footprint:   ${footprintText}`,
  ].join("\n");
}

export type TimelineEntry =
  | { kind: "lifecycle"; seq: number; ts: string; hookEventName: string }
  | { kind: "prompt"; seq: number; ts: string; text: string }
  | {
      kind: "command";
      seq: number;
      ts: string;
      command: string | null;
      outcome: Outcome;
      durationMs: number | null;
    }
  | {
      kind: "subagent";
      seq: number;
      ts: string;
      hookEventName: string;
      agentId: string | null;
      agentType: string | null;
    };

function renderOutcome(outcome: Outcome): string {
  switch (outcome.state) {
    case "success":
      return "success";
    case "failure":
      return `failure: ${toSingleLine(outcome.error)}`;
    case "absent":
      return ABSENT_MARKER;
  }
}

function renderEntry(entry: TimelineEntry): string {
  const prefix = `[${entry.seq}] ${entry.ts}`;
  switch (entry.kind) {
    case "lifecycle":
      return `${prefix}  ${entry.hookEventName}`;
    case "prompt":
      return `${prefix}  UserPromptSubmit  prompt: ${toSingleLine(entry.text)}`;
    case "command": {
      const commandText = entry.command !== null ? entry.command : ABSENT_MARKER;
      const durationText = entry.durationMs !== null ? `${entry.durationMs}ms` : ABSENT_MARKER;
      return (
        `${prefix}  command: ${commandText}` +
        `  outcome: ${renderOutcome(entry.outcome)}` +
        `  duration: ${durationText}`
      );
    }
    case "subagent":
      return (
        `${prefix}  ${entry.hookEventName}` +
        `  agent_id: ${renderAbsent(entry.agentId)}` +
        `  agent_type: ${renderAbsent(entry.agentType)}`
      );
  }
}

export function renderTimeline(entries: TimelineEntry[]): string {
  if (entries.length === 0) return "(no events)";
  return entries.map(renderEntry).join("\n");
}

export function renderShow(header: ShowHeaderInput, entries: TimelineEntry[]): string {
  return `${renderShowHeader(header)}\n\n${renderTimeline(entries)}`;
}

// The one place `show <session>` names an unknown id (spec: "An unknown
// session id exits nonzero with an error naming the id").
export function renderUnknownSession(sessionId: string): string {
  return `coreartifact show: unknown session '${sessionId}'`;
}
