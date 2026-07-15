// Session aggregate folding (pure) — derives the facet DELTA a batch of
// newly-parsed spool lines for one session contributes (docs/issues/ISS-0006.md
// "Status", "Facets and the degradation law").
//
// This folds only the events passed in — normally one ingest run's newly
// parsed lines for a session, never the full historical set, because the
// envelope's `git` sibling (the only source of sha_before/sha_after) is
// consumed at parse time and never persisted in `events.payload` (spec
// "Invariants": "The envelope's git sibling is not part of payload"). A
// session touched again in a later incremental ingest run folds only its
// NEW events; the caller merges this delta onto the existing row (existing
// wins when the delta has nothing new — see the engine's COALESCE/MIN/MAX
// merge), which is what makes a fact — once set — never regress or reset.
//
// kind is read from SessionStart alone (docs/recording-pass.md finding 3):
// `model` key present -> interactive, absent -> headless. Never inferred
// from any other field. A batch with no SessionStart contributes kind: null
// (the caller's merge keeps whatever the session already had, or leaves it
// NULL/ABSENT if it never had one — the drift fallback).

export type FoldedKind = "headless" | "interactive" | null;

export interface FoldableEvent {
  ts: string;
  hookEventName: string;
  // The decoded `event` member (JSON.parse'd), used only to read `model` on
  // a SessionStart line.
  eventObj: unknown;
  // The envelope's git sibling, present only on boundary lines when git
  // resolution succeeded at capture time.
  git?: { head?: string };
}

export interface SessionFacetsDelta {
  minTs: string;
  maxTs: string;
  kind: FoldedKind;
  shaBefore: string | null;
  shaAfter: string | null;
  endedAt: string | null;
}

function hasModelKey(eventObj: unknown): boolean {
  if (typeof eventObj !== "object" || eventObj === null || Array.isArray(eventObj)) return false;
  return typeof (eventObj as Record<string, unknown>).model === "string";
}

// Folds a non-empty, otherwise-arbitrarily-ordered batch of one session's
// events into a facets delta. Order-independent by construction (min/max
// over ts, last-write-wins is never needed since SessionStart/SessionEnd
// each occur at most once per genuine session).
export function foldSessionFacets(events: FoldableEvent[]): SessionFacetsDelta {
  if (events.length === 0) {
    throw new Error("foldSessionFacets: at least one event is required");
  }

  let minTs = events[0]!.ts;
  let maxTs = events[0]!.ts;
  let kind: FoldedKind = null;
  let shaBefore: string | null = null;
  let shaAfter: string | null = null;
  let endedAt: string | null = null;

  for (const event of events) {
    if (event.ts < minTs) minTs = event.ts;
    if (event.ts > maxTs) maxTs = event.ts;

    if (event.hookEventName === "SessionStart") {
      kind = hasModelKey(event.eventObj) ? "interactive" : "headless";
      if (typeof event.git?.head === "string" && event.git.head.length > 0) {
        shaBefore = event.git.head;
      }
    }

    if (event.hookEventName === "SessionEnd") {
      endedAt = event.ts;
      if (typeof event.git?.head === "string" && event.git.head.length > 0) {
        shaAfter = event.git.head;
      }
    }
  }

  return { minTs, maxTs, kind, shaBefore, shaAfter, endedAt };
}
