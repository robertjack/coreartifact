import { describe, test, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openLedger, type LedgerHandle } from "../../../src/core/ledger.js";
import {
  setAbsence,
  clearAbsence,
  getSessionAbsences,
  getAllAbsences,
  ABSENCE_FACETS,
  COST_ABSENCE_REASONS,
  KIND_ABSENCE_REASONS,
} from "../../../src/core/absence.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "iss14-absence-unit-"));
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

function openTestLedger(): LedgerHandle {
  const dbPath = path.join(makeTmpDir(), "ledger.db");
  return openLedger(dbPath);
}

function countAll(db: LedgerHandle["db"]): number {
  return (db.prepare("SELECT COUNT(*) as n FROM absences").get() as { n: number }).n;
}

describe("core/absence", () => {
  test("upsert idempotency: re-running the same set changes no row counts", () => {
    const handle = openTestLedger();
    try {
      setAbsence(handle.db, "sess-1", "cost", COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);
      expect(countAll(handle.db)).toBe(1);

      setAbsence(handle.db, "sess-1", "cost", COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);
      setAbsence(handle.db, "sess-1", "cost", COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);
      expect(countAll(handle.db)).toBe(1);
    } finally {
      handle.close();
    }
  });

  test("reason replacement: re-recording the same facet with a new reason overwrites, never adds a row", () => {
    const handle = openTestLedger();
    try {
      setAbsence(handle.db, "sess-2", "cost", COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);
      setAbsence(handle.db, "sess-2", "cost", COST_ABSENCE_REASONS.modelUnpinned("claude-sonnet-5"));

      const rows = getSessionAbsences(handle.db, "sess-2");
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBe("model unpinned: claude-sonnet-5");
    } finally {
      handle.close();
    }
  });

  test("clear-on-recovery: clearing an absence removes the row and never lingers", () => {
    const handle = openTestLedger();
    try {
      setAbsence(handle.db, "sess-3", "kind", KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED);
      expect(getSessionAbsences(handle.db, "sess-3")).toHaveLength(1);

      clearAbsence(handle.db, "sess-3", "kind");
      expect(getSessionAbsences(handle.db, "sess-3")).toHaveLength(0);

      // a session with no degraded facet has no rows at all -- never pre-seeded.
      expect(getSessionAbsences(handle.db, "sess-never-degraded")).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  test("closed vocabulary: an out-of-enumeration facet is rejected at runtime", () => {
    const handle = openTestLedger();
    try {
      expect(() =>
        setAbsence(handle.db, "sess-bad", "bogus-facet" as unknown as "cost", "some reason" as never),
      ).toThrow();

      expect(() => {
        // @ts-expect-error -- "bogus-facet" is not a member of AbsenceFacet; the
        // closed vocabulary is unrepresentable at the type level, not just
        // rejected at runtime.
        setAbsence(handle.db, "sess-bad", "bogus-facet", "some reason");
      }).toThrow();

      expect(() => {
        // @ts-expect-error -- a kind-only reason is not assignable to the cost facet.
        setAbsence(handle.db, "sess-bad", "cost", KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED);
      }).toThrow();

      expect(() => setAbsence(handle.db, "sess-bad", "cost", "not a real reason" as never)).toThrow();
    } finally {
      handle.close();
    }
  });

  test("the facet enumeration is exactly cost and kind", () => {
    expect([...ABSENCE_FACETS].sort()).toEqual(["cost", "kind"]);
  });

  // ISS-0025: the source-demote reason family -- KIND_ABSENCE_REASONS.sourceNotStartup
  // builds a per-source reason accepted by the same closed-vocabulary
  // validation as the other kind reasons; MODEL_ABSENT_NO_SOURCE_RECORDED
  // is the fixed literal for the "no source key at all" case.
  test("ISS-0025: sourceNotStartup builds a reason accepted by setAbsence's closed-vocabulary check", () => {
    const handle = openTestLedger();
    try {
      setAbsence(handle.db, "sess-clear", "kind", KIND_ABSENCE_REASONS.sourceNotStartup("clear"));
      const rows = getSessionAbsences(handle.db, "sess-clear");
      expect(rows).toEqual([
        { session_id: "sess-clear", facet: "kind", reason: "model absent, source not startup: clear" },
      ]);
    } finally {
      handle.close();
    }
  });

  test("ISS-0025: MODEL_ABSENT_NO_SOURCE_RECORDED is a distinct, valid kind reason", () => {
    const handle = openTestLedger();
    try {
      setAbsence(handle.db, "sess-no-source", "kind", KIND_ABSENCE_REASONS.MODEL_ABSENT_NO_SOURCE_RECORDED);
      const rows = getSessionAbsences(handle.db, "sess-no-source");
      expect(rows).toEqual([
        { session_id: "sess-no-source", facet: "kind", reason: "model absent, no source recorded" },
      ]);
      expect(KIND_ABSENCE_REASONS.MODEL_ABSENT_NO_SOURCE_RECORDED).not.toBe(
        KIND_ABSENCE_REASONS.NO_SESSION_START_CAPTURED,
      );
    } finally {
      handle.close();
    }
  });

  test("ISS-0025: an ad-hoc source-shaped string that does not match the sourceNotStartup prefix is rejected", () => {
    const handle = openTestLedger();
    try {
      expect(() =>
        setAbsence(handle.db, "sess-bad-source", "kind", "source is weird" as never),
      ).toThrow();
    } finally {
      handle.close();
    }
  });

  test("readers: one session and across all sessions, with facet and reason intact", () => {
    const handle = openTestLedger();
    try {
      setAbsence(handle.db, "sess-a", "cost", COST_ABSENCE_REASONS.TRANSCRIPT_SHAPE_UNRECOGNIZED);
      setAbsence(
        handle.db,
        "sess-b",
        "kind",
        KIND_ABSENCE_REASONS.MODEL_ABSENT_CONTRADICTED_BY_END_REASON,
      );

      const sessionARows = getSessionAbsences(handle.db, "sess-a");
      expect(sessionARows).toEqual([
        { session_id: "sess-a", facet: "cost", reason: "transcript shape unrecognized" },
      ]);

      const allRows = getAllAbsences(handle.db);
      expect(allRows).toEqual(
        expect.arrayContaining([
          { session_id: "sess-a", facet: "cost", reason: "transcript shape unrecognized" },
          {
            session_id: "sess-b",
            facet: "kind",
            reason: "model absent, contradicted by end-reason",
          },
        ]),
      );
    } finally {
      handle.close();
    }
  });
});
