import { describe, test, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// The ledger module (src/core/ledger.ts) already exists (ISS-0013 shipped
// schema v2, including the absences table) -- not a brand-new module, so this
// import is a plain static import, not a caught dynamic one.
import { openLedger } from "../../../src/core/ledger.js";

// src/core/absence.ts (this issue's [files] owns entry) does not exist yet --
// loaded through a caught dynamic import so a missing module fails individual
// assertions (red), never the whole file at collection.
const MODULE_PATH = "../../../src/core/absence.js";

async function loadAbsenceModule(): Promise<any> {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

function requireExport(mod: any, name: string): any {
  if (!mod) throw new Error("src/core/absence.ts not implemented yet");
  const value = mod[name];
  if (value === undefined) throw new Error(`src/core/absence.ts does not export ${name} yet`);
  return value;
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "iss14-absence-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
});

function openTestLedger() {
  const dbPath = path.join(makeTmpDir(), "ledger.db");
  return openLedger(dbPath);
}

function absenceCountFor(db: any, sessionId: string, facet: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as n FROM absences WHERE session_id = ? AND facet = ?")
    .get(sessionId, facet) as { n: number };
  return row.n;
}

function absenceCountForSession(db: any, sessionId: string): number {
  const row = db.prepare("SELECT COUNT(*) as n FROM absences WHERE session_id = ?").get(sessionId) as {
    n: number;
  };
  return row.n;
}

describe("ISS-0014 absence-reasons record", () => {
  test(
    "Recording an absence for a session and facet upserts at most one row per session and facet pair: re-recording the same facet replaces the reason rather than adding a row, and recomputing the same absences changes no row counts.",
    async () => {
      const mod = await loadAbsenceModule();
      const setAbsence = requireExport(mod, "setAbsence");
      const COST_ABSENCE_REASONS = requireExport(mod, "COST_ABSENCE_REASONS");

      const handle = openTestLedger();
      try {
        const sessionId = "sess-upsert";

        setAbsence(handle.db, sessionId, "cost", COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);
        expect(absenceCountFor(handle.db, sessionId, "cost")).toBe(1);

        // re-recording the same facet with a DIFFERENT reason replaces the row,
        // it does not add a second one.
        setAbsence(handle.db, sessionId, "cost", COST_ABSENCE_REASONS.TRANSCRIPT_SHAPE_UNRECOGNIZED);
        expect(absenceCountFor(handle.db, sessionId, "cost")).toBe(1);
        const rowAfterReplace = handle.db
          .prepare("SELECT reason FROM absences WHERE session_id = ? AND facet = ?")
          .get(sessionId, "cost") as { reason: string };
        expect(rowAfterReplace.reason).toBe("transcript shape unrecognized");

        // recomputing the identical absence (an idempotent re-run) changes no
        // row counts at all -- neither for the pair nor the whole table.
        setAbsence(handle.db, sessionId, "cost", COST_ABSENCE_REASONS.TRANSCRIPT_SHAPE_UNRECOGNIZED);
        expect(absenceCountFor(handle.db, sessionId, "cost")).toBe(1);
        const totalRows = handle.db.prepare("SELECT COUNT(*) as n FROM absences").get() as { n: number };
        expect(totalRows.n).toBe(1);
      } finally {
        handle.close();
      }
    },
  );

  test(
    "The absence facet and reason vocabulary is closed and enumerated: cost carries exactly the reasons transcript unavailable, transcript shape unrecognized, and model unpinned: <model>; kind carries exactly no SessionStart captured and model absent, contradicted by end-reason; a caller cannot record a facet outside the enumeration.",
    async () => {
      const mod = await loadAbsenceModule();
      const ABSENCE_FACETS = requireExport(mod, "ABSENCE_FACETS");
      const COST_ABSENCE_REASONS = requireExport(mod, "COST_ABSENCE_REASONS");
      const KIND_ABSENCE_REASONS = requireExport(mod, "KIND_ABSENCE_REASONS");
      const setAbsence = requireExport(mod, "setAbsence");

      // the closed enumeration itself, checked against the spec's exact
      // strings -- an independent oracle, not values recomputed from the
      // implementation.
      expect([...ABSENCE_FACETS].sort()).toEqual(["cost", "kind"]);
      expect(COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE).toBe("transcript unavailable");
      expect(COST_ABSENCE_REASONS.TRANSCRIPT_SHAPE_UNRECOGNIZED).toBe("transcript shape unrecognized");
      expect(COST_ABSENCE_REASONS.modelUnpinned("claude-sonnet-5")).toBe("model unpinned: claude-sonnet-5");
      expect(KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED).toBe("no SessionStart captured");
      expect(KIND_ABSENCE_REASONS.MODEL_ABSENT_CONTRADICTED_BY_END_REASON).toBe(
        "model absent, contradicted by end-reason",
      );

      const handle = openTestLedger();
      try {
        // a caller cannot record a facet outside the enumeration.
        expect(() => setAbsence(handle.db, "sess-bad-facet", "bogus-facet", "some reason")).toThrow();
      } finally {
        handle.close();
      }
    },
  );

  test(
    "When a facet recovers on a later recompute, its absence row is cleared for that session — an absence never outlives its cause — and a session with no degraded facet has no absences rows at all.",
    async () => {
      const mod = await loadAbsenceModule();
      const setAbsence = requireExport(mod, "setAbsence");
      const clearAbsence = requireExport(mod, "clearAbsence");
      const COST_ABSENCE_REASONS = requireExport(mod, "COST_ABSENCE_REASONS");

      const handle = openTestLedger();
      try {
        const sessionId = "sess-recover";
        setAbsence(handle.db, sessionId, "cost", COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);
        expect(absenceCountFor(handle.db, sessionId, "cost")).toBe(1);

        // the facet recovers on a later recompute: the writer clears it
        // explicitly, and the row does not linger.
        clearAbsence(handle.db, sessionId, "cost");
        expect(absenceCountFor(handle.db, sessionId, "cost")).toBe(0);
        expect(absenceCountForSession(handle.db, sessionId)).toBe(0);

        // a session that never had a degraded facet has no absences rows at
        // all -- absence rows are never pre-seeded or defaulted.
        expect(absenceCountForSession(handle.db, "sess-clean")).toBe(0);
      } finally {
        handle.close();
      }
    },
  );

  test(
    "A read API returns the absences for one session and the set across all sessions with facet and reason intact, which is the enumeration doctor renders.",
    async () => {
      const mod = await loadAbsenceModule();
      const setAbsence = requireExport(mod, "setAbsence");
      const getSessionAbsences = requireExport(mod, "getSessionAbsences");
      const getAllAbsences = requireExport(mod, "getAllAbsences");
      const COST_ABSENCE_REASONS = requireExport(mod, "COST_ABSENCE_REASONS");
      const KIND_ABSENCE_REASONS = requireExport(mod, "KIND_ABSENCE_REASONS");

      const handle = openTestLedger();
      try {
        setAbsence(handle.db, "sess-a", "cost", COST_ABSENCE_REASONS.modelUnpinned("claude-sonnet-5"));
        setAbsence(handle.db, "sess-a", "kind", KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED);
        setAbsence(
          handle.db,
          "sess-b",
          "kind",
          KIND_ABSENCE_REASONS.MODEL_ABSENT_CONTRADICTED_BY_END_REASON,
        );

        const sessionARows = getSessionAbsences(handle.db, "sess-a");
        expect(sessionARows).toHaveLength(2);
        expect(sessionARows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ facet: "cost", reason: "model unpinned: claude-sonnet-5" }),
            expect.objectContaining({ facet: "kind", reason: "no SessionStart captured" }),
          ]),
        );

        const allRows = getAllAbsences(handle.db);
        expect(allRows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              session_id: "sess-a",
              facet: "cost",
              reason: "model unpinned: claude-sonnet-5",
            }),
            expect.objectContaining({
              session_id: "sess-a",
              facet: "kind",
              reason: "no SessionStart captured",
            }),
            expect.objectContaining({
              session_id: "sess-b",
              facet: "kind",
              reason: "model absent, contradicted by end-reason",
            }),
          ]),
        );
      } finally {
        handle.close();
      }
    },
  );
});
