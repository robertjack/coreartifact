// The drift detector — kind reconciliation (docs/issues/ISS-0020.md "The
// kind reconciliation", operator-ruled 2026-07-16). Pure classification
// logic over a session's full event set; the caller (ingest) is
// responsible for reading events from the ledger and recording the
// result through the absence-record contract (src/core/absence.ts).
//
// SessionEnd `reason` is demote-only corroboration: it never classifies a
// session by itself, it only refuses a contradicted classification. The
// only reason value that contradicts is `prompt_input_exit` (interactive
// clean-exit only); every other reason, and no SessionEnd at all
// (SIGKILL-shaped input), is treated as consistent with headless.
import { KIND_ABSENCE_REASONS, type KindAbsenceReason } from "../core/absence.js";

export interface DriftEvent {
  hookEventName: string;
  // The decoded `event` member (JSON.parse'd) of a spool line.
  eventObj: unknown;
}

export type KindClassification =
  | { kind: "interactive" | "headless"; reason: null }
  | { kind: null; reason: KindAbsenceReason };

const CONTRADICTING_END_REASON = "prompt_input_exit";

function hasModelKey(eventObj: unknown): boolean {
  if (typeof eventObj !== "object" || eventObj === null || Array.isArray(eventObj)) return false;
  return typeof (eventObj as Record<string, unknown>).model === "string";
}

function endReasonOf(eventObj: unknown): string | undefined {
  if (typeof eventObj !== "object" || eventObj === null || Array.isArray(eventObj)) return undefined;
  const reason = (eventObj as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : undefined;
}

// The classification ladder (docs/issues/ISS-0020.md):
//   1. SessionStart present with `model` -> interactive.
//   2. SessionStart present without `model`, end-signal consistent
//      (reason "other", or no SessionEnd at all) -> headless.
//   3. SessionStart present without `model`, contradicted by end-reason
//      "prompt_input_exit" -> ABSENT, "model absent, contradicted by end-reason".
//   4. No SessionStart line at all -> ABSENT, "no SessionStart captured".
export function classifySessionKind(events: DriftEvent[]): KindClassification {
  const sessionStart = events.find((event) => event.hookEventName === "SessionStart");
  if (!sessionStart) {
    return { kind: null, reason: KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED };
  }

  if (hasModelKey(sessionStart.eventObj)) {
    return { kind: "interactive", reason: null };
  }

  const sessionEnd = events.find((event) => event.hookEventName === "SessionEnd");
  const endReason = sessionEnd ? endReasonOf(sessionEnd.eventObj) : undefined;
  if (endReason === CONTRADICTING_END_REASON) {
    return { kind: null, reason: KIND_ABSENCE_REASONS.MODEL_ABSENT_CONTRADICTED_BY_END_REASON };
  }

  return { kind: "headless", reason: null };
}
