// Status derivation (pure) — a session's status is a pure function of
// (end timestamp genuinely present?, last event timestamp, now). Never a
// one-way door: recompute on every ingest so a late-ingested SessionEnd
// flips closed-inferred back to closed-clean.
//
// "Present" means genuinely present: an empty string or undefined endedAt
// is NOT a captured SessionEnd. Treating it as one would fabricate
// closed-clean for a crashed session.

export const STALENESS_THRESHOLD_MS = 12 * 60 * 60 * 1000;

export type SessionStatus = "open" | "closed-clean" | "closed-inferred";

export interface DeriveStatusInput {
  endedAt?: string;
  lastEventTs: string;
  now: string;
}

export function deriveStatus(input: DeriveStatusInput): SessionStatus {
  if (typeof input.endedAt === "string" && input.endedAt.length > 0) {
    return "closed-clean";
  }

  const lastEventMs = new Date(input.lastEventTs).getTime();
  const nowMs = new Date(input.now).getTime();

  // An unparseable timestamp must not fabricate liveness. `new
  // Date("garbage").getTime()` is NaN, and `NaN > threshold` is false, so
  // falling through to "open" would silently report a session with a
  // corrupt timestamp as live forever. Fail toward the honest,
  // non-optimistic state instead: this function must fail toward "we don't
  // know", never toward a flattering claim, in either direction.
  if (!Number.isFinite(lastEventMs) || !Number.isFinite(nowMs)) {
    return "closed-inferred";
  }

  if (nowMs - lastEventMs > STALENESS_THRESHOLD_MS) {
    return "closed-inferred";
  }

  return "open";
}
