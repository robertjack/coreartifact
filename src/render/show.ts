// The `show` renderer — a header (shas, footprint) followed by a flat
// chronological timeline (docs/issues/ISS-0008.md "What show prints"). Pure
// formatting only, same stance as src/render/log.ts: every field here is
// already computed by the caller (src/cli/commands/show.ts) from the
// ledger/facets; this module never touches SQLite or the spool.
//
// Flat, not a tree (spec): entries render in `seq` order with no indentation
// or grouping by agent_id — the nesting keys are carried on each entry but
// v1 never nests the presentation.
import { ABSENT_MARKER, renderAbsent, renderCostUsd } from "./absent.js";
import type { Outcome } from "../facets/outcome.js";

export interface ShowHeaderInput {
  sessionId: string;
  shaBefore: string | null;
  shaAfter: string | null;
  footprint: string[];
  // ISS-0019: the cost enrichment facet, rendered with a derived marker —
  // see src/render/log.ts's own header comment for the same field.
  costUsd: number | null;
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
    `cost:        ${renderCostUsd(input.costUsd)}`,
  ].join("\n");
}

// ISS-0018: the minimal test-results badge — enough to satisfy "rendered in
// show" for a claimed command. The full badge/column treatment and absent
// markers belong to the render-depth slice that touches this file
// downstream; this shape stays thin on purpose (a plain data bag over the
// ledger's test_results row) so that slice amends without rework.
export interface TestResultsBadge {
  passed: number;
  failed: number;
  skipped: number;
  failedNames: string[];
  durationMs: number | null;
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
      // Absent (undefined) or null when no parser claimed this command
      // (facet absent, or the caller predates this facet) — see schema.md
      // degradation law. Optional so this addition stays source-compatible
      // with any existing caller that does not yet supply it.
      testResults?: TestResultsBadge | null;
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

// Minimal badge line for a claimed command: counts, failed names, duration
// (spec "Render" — the full badge/column treatment lands in the render-depth
// slice). Nothing is rendered when no parser claimed the command.
function renderTestResultsBadge(testResults: TestResultsBadge): string {
  const namesText =
    testResults.failedNames.length > 0 ? `  failed: [${testResults.failedNames.join(", ")}]` : "";
  const durationText = testResults.durationMs !== null ? `${testResults.durationMs}ms` : ABSENT_MARKER;
  return (
    `  tests: ${testResults.passed} passed, ${testResults.failed} failed, ${testResults.skipped} skipped` +
    namesText +
    `  test_duration: ${durationText}`
  );
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
      const badge = entry.testResults != null ? renderTestResultsBadge(entry.testResults) : "";
      return (
        `${prefix}  command: ${commandText}` +
        `  outcome: ${renderOutcome(entry.outcome)}` +
        `  duration: ${durationText}` +
        badge
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

// ISS-0012: an ambiguous prefix (or a full id present in more than one
// repo's ledger) fails honestly rather than silently picking one — every
// candidate is listed with its full session id AND its repo root, since
// that pair is what disambiguates a shared id across two repos.
export function renderAmbiguousMatch(
  sessionArg: string,
  candidates: { sessionId: string; repoRoot: string }[],
): string {
  const lines = [
    `coreartifact show: ambiguous session '${sessionArg}' matches ${candidates.length} sessions:`,
    ...candidates.map((c) => `  ${c.sessionId}  ${c.repoRoot}`),
  ];
  return lines.join("\n");
}
