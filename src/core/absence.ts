// Absence-reasons record — the drift detector's contract (ISS-0014,
// schema.md / spec-v1.md fragile-dependency register).
//
// Recompute-upsert semantics over the `absences` table (schema v2, created
// by ISS-0013): each ingest writes the current truth for a session x facet
// pair via INSERT ... ON CONFLICT DO UPDATE, and clears the row explicitly
// when the facet recovers. This table holds zero ground truth of its own —
// it is a derived projection, rebuildable from the spool + transcripts at
// path. The vocabulary of facets and reasons is closed: these exact strings,
// no synonyms (docs/spec-v1.md fragile-dependency register).

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

export const ABSENCE_FACETS = ["cost", "kind"] as const;
export type AbsenceFacet = (typeof ABSENCE_FACETS)[number];

export const COST_ABSENCE_REASONS = {
  TRANSCRIPT_UNAVAILABLE: "transcript unavailable",
  TRANSCRIPT_SHAPE_UNRECOGNIZED: "transcript shape unrecognized",
  modelUnpinned: (model: string): `model unpinned: ${string}` => `model unpinned: ${model}`,
} as const;

export const KIND_ABSENCE_REASONS = {
  NO_SESSION_START_CAPTURED: "no SessionStart captured",
  MODEL_ABSENT_CONTRADICTED_BY_END_REASON: "model absent, contradicted by end-reason",
} as const;

export type CostAbsenceReason =
  | typeof COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE
  | typeof COST_ABSENCE_REASONS.TRANSCRIPT_SHAPE_UNRECOGNIZED
  | `model unpinned: ${string}`;

export type KindAbsenceReason =
  | typeof KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED
  | typeof KIND_ABSENCE_REASONS.MODEL_ABSENT_CONTRADICTED_BY_END_REASON;

// Facet -> its own reason type, so a caller passing a "kind" reason for the
// "cost" facet (or vice versa) fails to typecheck, not just at runtime.
export interface AbsenceReasonByFacet {
  cost: CostAbsenceReason;
  kind: KindAbsenceReason;
}

export interface AbsenceRow {
  session_id: string;
  facet: AbsenceFacet;
  reason: string;
}

const MODEL_UNPINNED_PREFIX = "model unpinned: ";

const COST_REASON_LITERALS: ReadonlySet<string> = new Set([
  COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE,
  COST_ABSENCE_REASONS.TRANSCRIPT_SHAPE_UNRECOGNIZED,
]);

const KIND_REASON_LITERALS: ReadonlySet<string> = new Set([
  KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED,
  KIND_ABSENCE_REASONS.MODEL_ABSENT_CONTRADICTED_BY_END_REASON,
]);

function isValidReason(facet: string, reason: string): boolean {
  if (reason === "") return false;
  if (facet === "cost") {
    return (
      COST_REASON_LITERALS.has(reason) ||
      (reason.startsWith(MODEL_UNPINNED_PREFIX) && reason.length > MODEL_UNPINNED_PREFIX.length)
    );
  }
  if (facet === "kind") {
    return KIND_REASON_LITERALS.has(reason);
  }
  return false;
}

function assertKnownFacet(facet: string): asserts facet is AbsenceFacet {
  if (!(ABSENCE_FACETS as readonly string[]).includes(facet)) {
    throw new Error(`absence facet outside the closed vocabulary: ${facet}`);
  }
}

// Recompute-upsert: the caller (cost enrichment, the drift detector) sets
// the absence for a session x facet pair on every ingest recompute. Idempotent
// by construction — INSERT ... ON CONFLICT DO UPDATE means re-running with the
// same reason changes no row counts, and re-running with a different reason
// replaces rather than duplicates (PRIMARY KEY (session_id, facet), ISS-0013).
export function setAbsence<F extends AbsenceFacet>(
  db: SqliteDatabase,
  sessionId: string,
  facet: F,
  reason: AbsenceReasonByFacet[F],
): void {
  assertKnownFacet(facet);
  if (!isValidReason(facet, reason)) {
    throw new Error(`absence reason outside the closed vocabulary for facet "${facet}": ${reason}`);
  }
  db.prepare(
    `INSERT INTO absences (session_id, facet, reason) VALUES (?, ?, ?)
     ON CONFLICT(session_id, facet) DO UPDATE SET reason = excluded.reason`,
  ).run(sessionId, facet, reason);
}

// Explicit clear for when a facet recovers on a later recompute — an
// absence must never outlive its cause.
export function clearAbsence(db: SqliteDatabase, sessionId: string, facet: AbsenceFacet): void {
  assertKnownFacet(facet);
  db.prepare("DELETE FROM absences WHERE session_id = ? AND facet = ?").run(sessionId, facet);
}

export function getSessionAbsences(db: SqliteDatabase, sessionId: string): AbsenceRow[] {
  return db
    .prepare("SELECT session_id, facet, reason FROM absences WHERE session_id = ?")
    .all(sessionId) as AbsenceRow[];
}

// doctor's query: the whole set, served by the primary key.
export function getAllAbsences(db: SqliteDatabase): AbsenceRow[] {
  return db.prepare("SELECT session_id, facet, reason FROM absences").all() as AbsenceRow[];
}
