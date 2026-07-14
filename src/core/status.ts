// Status derivation (pure) — a session's status is a pure function of
// (end timestamp present?, last event timestamp, now). Never a one-way
// door: recomputed on every ingest so a late-ingested SessionEnd flips
// closed-inferred back to closed-clean.

export const STALENESS_THRESHOLD_MS = 12 * 60 * 60 * 1000;

export type SessionStatus = 'open' | 'closed-clean' | 'closed-inferred';

export interface DeriveStatusInput {
  endedAt: string | null;
  lastEventAt: string;
  now: string;
}

export function deriveStatus(input: DeriveStatusInput): SessionStatus {
  if (input.endedAt !== null) {
    return 'closed-clean';
  }

  const lastEventMs = new Date(input.lastEventAt).getTime();
  const nowMs = new Date(input.now).getTime();

  if (nowMs - lastEventMs > STALENESS_THRESHOLD_MS) {
    return 'closed-inferred';
  }

  return 'open';
}
