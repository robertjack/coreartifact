// Unit test for status recomputation driven through the ingest engine's
// injectable "now" (docs/issues/ISS-0006.md "Test-harness contract" —
// "Replaying payloads with old timestamps does NOT work ... the named
// mechanism: drive the ingest module's injectable 'now' from a unit test
// under tests/unit/ingest/, covering the closed-inferred derivation and the
// flip back to closed-clean.").
//
// This drives `ingest()` directly (not through the CLI/hook subprocess seam)
// against a hand-authored spool file — legitimate here because this is
// testing the ingest module's own clock-dependent behavior in isolation,
// not asserting anything about what the hook artifact writes (that is the
// acceptance seam's job, and it never hand-authors payloads other than the
// fixed corrupt-line fixture).
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore -- node:sqlite has no ambient types available in this sandbox (see src/core/ledger.ts)
import { DatabaseSync } from "node:sqlite";
import { ingest } from "../../../src/ingest/index.js";
import { getPaths } from "../../../src/core/paths.js";

function envelopeLine(ts: string, event: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, ts, event })}\n`;
}

function readStatus(ledgerPath: string, sessionId: string): string {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT status FROM sessions WHERE session_id = ?").get(sessionId) as
      | { status: string }
      | undefined;
    if (!row) throw new Error(`no session row for ${sessionId}`);
    return row.status;
  } finally {
    db.close();
  }
}

describe("ingest: status recomputation via injectable now", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRepoRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iss0006-status-unit-"));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".coreartifact"), { recursive: true });
    return dir;
  }

  it("derives closed-inferred when no SessionEnd was captured and last_event_at is older than the 12h staleness threshold", async () => {
    const repoRoot = makeRepoRoot();
    const paths = getPaths(repoRoot);
    const sessionId = "unit-status-inferred";
    const startedAt = "2026-07-14T00:00:00.000Z";

    fs.writeFileSync(
      paths.spool,
      envelopeLine(startedAt, { session_id: sessionId, cwd: repoRoot, hook_event_name: "SessionStart" }),
    );

    // 13 hours later: past the named 12h staleness constant, no SessionEnd.
    const thirteenHoursLater = "2026-07-14T13:00:00.000Z";
    await ingest(repoRoot, { now: () => thirteenHoursLater });

    expect(readStatus(paths.ledger, sessionId)).toBe("closed-inferred");
  });

  it("stays open when no SessionEnd was captured but last_event_at is recent", async () => {
    const repoRoot = makeRepoRoot();
    const paths = getPaths(repoRoot);
    const sessionId = "unit-status-open";
    const startedAt = "2026-07-14T00:00:00.000Z";

    fs.writeFileSync(
      paths.spool,
      envelopeLine(startedAt, { session_id: sessionId, cwd: repoRoot, hook_event_name: "SessionStart" }),
    );

    const oneHourLater = "2026-07-14T01:00:00.000Z";
    await ingest(repoRoot, { now: () => oneHourLater });

    expect(readStatus(paths.ledger, sessionId)).toBe("open");
  });

  it("flips closed-inferred back to closed-clean on a later ingest that reads a late-appended SessionEnd — never a one-way door", async () => {
    const repoRoot = makeRepoRoot();
    const paths = getPaths(repoRoot);
    const sessionId = "unit-status-flip";
    const startedAt = "2026-07-14T00:00:00.000Z";

    fs.writeFileSync(
      paths.spool,
      envelopeLine(startedAt, { session_id: sessionId, cwd: repoRoot, hook_event_name: "SessionStart" }),
    );

    const thirteenHoursLater = "2026-07-14T13:00:00.000Z";
    await ingest(repoRoot, { now: () => thirteenHoursLater });
    expect(readStatus(paths.ledger, sessionId)).toBe("closed-inferred");

    // Status must be recomputed purely from wall-clock time passing, with
    // ZERO new spool lines read in this call.
    const fourteenHoursLater = "2026-07-14T14:00:00.000Z";
    await ingest(repoRoot, { now: () => fourteenHoursLater });
    expect(readStatus(paths.ledger, sessionId)).toBe("closed-inferred");

    // Now a genuine SessionEnd lands, late.
    fs.appendFileSync(
      paths.spool,
      envelopeLine(fourteenHoursLater, { session_id: sessionId, cwd: repoRoot, hook_event_name: "SessionEnd", reason: "other" }),
    );
    await ingest(repoRoot, { now: () => fourteenHoursLater });

    expect(readStatus(paths.ledger, sessionId)).toBe("closed-clean");
  });
});
