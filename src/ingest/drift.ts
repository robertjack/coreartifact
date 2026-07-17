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
// (SIGKILL-shaped input), is treated as consistent with headless. This
// corroboration only ever applies within "startup"-mode streams (see the
// source-demote gate below, docs/issues/ISS-0025.md) -- it is unchanged.
//
// The source-demote gate (ISS-0025, docs/recording-pass.md findings 3 and
// 9, operator-ruled same day: demote-only on non-startup sources): `model`
// absent is only ever verified to mean `headless` at `source: "startup"`.
// Any other observed source (the recorded real case: "clear" via `/clear`),
// or no `source` key at all, is an unverified start mode -- ABSENT, never
// classified, naming the observed source mode in the reason so it stays
// derivable purely from the spool.
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
const VERIFIED_HEADLESS_SOURCE = "startup";

function hasModelKey(eventObj: unknown): boolean {
  if (typeof eventObj !== "object" || eventObj === null || Array.isArray(eventObj)) return false;
  return typeof (eventObj as Record<string, unknown>).model === "string";
}

function sourceOf(eventObj: unknown): string | undefined {
  if (typeof eventObj !== "object" || eventObj === null || Array.isArray(eventObj)) return undefined;
  const source = (eventObj as Record<string, unknown>).source;
  return typeof source === "string" ? source : undefined;
}

function endReasonOf(eventObj: unknown): string | undefined {
  if (typeof eventObj !== "object" || eventObj === null || Array.isArray(eventObj)) return undefined;
  const reason = (eventObj as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : undefined;
}

// The classification ladder (docs/issues/ISS-0020.md, extended by
// docs/issues/ISS-0025.md):
//   1. SessionStart present with `model` -> interactive, any source.
//   2. SessionStart present without `model`, source "startup" (the only
//      fixture-verified cell), end-signal consistent (reason "other", or
//      no SessionEnd at all) -> headless.
//   3. SessionStart present without `model`, source "startup", contradicted
//      by end-reason "prompt_input_exit" -> ABSENT,
//      "model absent, contradicted by end-reason".
//   4. SessionStart present without `model`, source missing entirely ->
//      ABSENT, "model absent, no source recorded".
//   5. SessionStart present without `model`, source present but not
//      "startup" (e.g. "clear") -> ABSENT, naming the observed source.
//      Demote-only: never classify an unobserved start mode from n=1.
//   6. No SessionStart line at all -> ABSENT, "no SessionStart captured".
export function classifySessionKind(events: DriftEvent[]): KindClassification {
  const sessionStart = events.find((event) => event.hookEventName === "SessionStart");
  if (!sessionStart) {
    return { kind: null, reason: KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED };
  }

  if (hasModelKey(sessionStart.eventObj)) {
    return { kind: "interactive", reason: null };
  }

  const source = sourceOf(sessionStart.eventObj);
  if (source === undefined) {
    return { kind: null, reason: KIND_ABSENCE_REASONS.MODEL_ABSENT_NO_SOURCE_RECORDED };
  }
  if (source !== VERIFIED_HEADLESS_SOURCE) {
    return { kind: null, reason: KIND_ABSENCE_REASONS.sourceNotStartup(source) };
  }

  const sessionEnd = events.find((event) => event.hookEventName === "SessionEnd");
  const endReason = sessionEnd ? endReasonOf(sessionEnd.eventObj) : undefined;
  if (endReason === CONTRADICTING_END_REASON) {
    return { kind: null, reason: KIND_ABSENCE_REASONS.MODEL_ABSENT_CONTRADICTED_BY_END_REASON };
  }

  return { kind: "headless", reason: null };
}
