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

// Folds a non-empty batch of one session's events (spool line order) into a
// facets delta. Every facet is FIRST-non-null-wins, mirroring two other
// authorities exactly: the incremental upsert's COALESCE merge
// (src/ingest/index.ts — "a fact once set never resets") and the kind
// classifier's first-SessionStart find (src/ingest/drift.ts). The previous
// last-write-wins loop rested on "SessionStart occurs at most once per
// genuine session" — falsified 2026-07-20 by an observed `source: "resume"`
// second SessionStart on a live resumed session (no `model` key, fresh
// git.head), which made a full rebuild disagree with the incrementally
// grown ledger on sha_before: the rebuild law violated in one facet.
// First-wins restores rebuild ≡ incremental for any number of boundary
// lines. (Whether a resumed session's ended_at SHOULD advance past its
// first SessionEnd is a separate, unruled semantics question — both paths
// currently agree on first-wins, and changing that is an operator ruling,
// not a fold detail.)
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
      if (kind === null) {
        kind = hasModelKey(event.eventObj) ? "interactive" : "headless";
      }
      if (shaBefore === null && typeof event.git?.head === "string" && event.git.head.length > 0) {
        shaBefore = event.git.head;
      }
    }

    if (event.hookEventName === "SessionEnd") {
      if (endedAt === null) {
        endedAt = event.ts;
      }
      if (shaAfter === null && typeof event.git?.head === "string" && event.git.head.length > 0) {
        shaAfter = event.git.head;
      }
    }
  }

  return { minTs, maxTs, kind, shaBefore, shaAfter, endedAt };
}
