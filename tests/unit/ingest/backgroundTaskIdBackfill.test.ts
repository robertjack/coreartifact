// F143: background_task_id is promoted only at INSERT time (`ON
// CONFLICT(line_no) DO NOTHING`, behind the HWM byte cursor), so rows
// written by an older build (or any build before extractBackgroundTaskId
// was wired up) stayed NULL forever, permanently stuck ABSENT at show time
// even though the resolving TaskOutput poll already sits in the ledger.
// Simulates that pre-upgrade state directly (NULLing an already-ingested
// row's background_task_id) and asserts a later `ingest()` call — even one
// with zero new spool bytes — backfills it from the payload already on
// disk.
import { afterAll, describe, expect, it } from "vitest";
import { createTmpRepo, runCli, type TmpRepo } from "../../acceptance/harness/index.js";
import { getPaths } from "../../../src/core/paths.js";
import { openLedger, type EventRow } from "../../../src/core/ledger.js";
import { ingest } from "../../../src/ingest/index.js";

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { appendFileSync as appendFileSyncFn } from "node:fs";
const appendFileSync = appendFileSyncFn as (path: string, data: string) => void;

const SESSION_ID = "backfill-session-1";
const TASK_ID = "task-backfill-1";

function spoolLine(ts: string, event: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, ts, event })}\n`;
}

describe("ingest: background_task_id backfill for pre-upgrade rows (F143)", () => {
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it("backfills a NULLed-out background_task_id on both the backgrounding and resolving events from their stored payload", async () => {
    const repo = await createTmpRepo();
    tmpRepos.push(repo);
    const opts = { cwd: repo.root, home: repo.home, registryPath: repo.registryPath };
    const init = await runCli(["init"], opts);
    expect(init.exitCode, `test setup invariant: init did not exit 0; stderr: ${init.stderr}`).toBe(0);

    const paths = getPaths(repo.root);

    // A backgrounding PostToolUse and its resolving TaskOutput poll — same
    // shape ISS-0024's own fixture uses.
    appendFileSync(
      paths.spool,
      spoolLine("2026-01-01T00:00:00.000Z", {
        session_id: SESSION_ID,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "sleep 90" },
        tool_response: { backgroundTaskId: TASK_ID },
      }),
    );
    appendFileSync(
      paths.spool,
      spoolLine("2026-01-01T00:01:00.000Z", {
        session_id: SESSION_ID,
        hook_event_name: "PostToolUse",
        tool_name: "TaskOutput",
        tool_input: { task_id: TASK_ID },
        tool_response: { task: { exitCode: 0 } },
      }),
    );

    // First ingest: background_task_id is promoted normally at INSERT time.
    const firstReport = await ingest(repo.root);
    expect(firstReport.eventsInserted).toBe(2);

    {
      const handle = openLedger(paths.ledger);
      const rows = handle.db
        .prepare("SELECT line_no, background_task_id FROM events WHERE session_id = ? ORDER BY line_no")
        .all(SESSION_ID) as EventRow[];
      handle.close();
      expect(rows.map((r) => r.background_task_id)).toEqual([TASK_ID, TASK_ID]);

      // Simulate the pre-upgrade state directly: a build that predates
      // extractBackgroundTaskId (or the column) left these NULL forever.
      const wipeHandle = openLedger(paths.ledger);
      wipeHandle.db.exec("UPDATE events SET background_task_id = NULL WHERE session_id = '" + SESSION_ID + "'");
      wipeHandle.close();

      const wipedHandle = openLedger(paths.ledger);
      const wipedRows = wipedHandle.db
        .prepare("SELECT background_task_id FROM events WHERE session_id = ? ORDER BY line_no")
        .all(SESSION_ID) as EventRow[];
      wipedHandle.close();
      expect(
        wipedRows.map((r) => r.background_task_id),
        "test setup invariant: the wipe did not actually NULL the column",
      ).toEqual([null, null]);
    }

    // A second ingest with ZERO new spool bytes must still resolve the
    // backfill — it isn't gated on this run touching the session.
    const secondReport = await ingest(repo.root);
    expect(secondReport.eventsInserted).toBe(0);

    const handle = openLedger(paths.ledger);
    const rows = handle.db
      .prepare("SELECT background_task_id FROM events WHERE session_id = ? ORDER BY line_no")
      .all(SESSION_ID) as EventRow[];
    handle.close();
    expect(
      rows.map((r) => r.background_task_id),
      "background_task_id was not backfilled on a no-new-bytes ingest run",
    ).toEqual([TASK_ID, TASK_ID]);
  });
});
