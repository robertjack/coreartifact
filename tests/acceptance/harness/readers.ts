// Assertion helpers over raw fs (spec-v1.md "Design constraints", ISS-0003):
// read the spool as parsed envelope lines, open the ledger read-only and
// query sessions / events / footprint rows. Later slices assert on ledger
// rows constantly — this is the one place that knows how, so drift never
// starts from re-implementing SQLite access per test file.
import { existsSync, readFileSync } from "node:fs";
// @ts-ignore -- node:sqlite has no ambient types available in this sandbox (see src/core/ledger.ts)
import { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";
import { parseEnvelope, type ParseEnvelopeResult } from "../../../src/core/envelope.js";
import type { SessionRow, EventRow, FootprintRow } from "../../../src/core/ledger.js";

const DatabaseSync = DatabaseSyncCtor as unknown as new (
  path: string,
  options?: { readOnly?: boolean }
) => {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

/** Read the spool as a list of parsed envelope lines (never a raw string split). */
export function readSpool(spoolPath: string): ParseEnvelopeResult[] {
  if (!existsSync(spoolPath)) return [];
  const text = readFileSync(spoolPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseEnvelope);
}

export interface LedgerSnapshot {
  sessions: SessionRow[];
  events: EventRow[];
  footprint: FootprintRow[];
}

/** Open the ledger read-only and return its sessions/events/footprint rows. */
export function readLedger(ledgerPath: string): LedgerSnapshot {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    return {
      sessions: db.prepare("SELECT * FROM sessions").all() as SessionRow[],
      events: db.prepare("SELECT * FROM events ORDER BY line_no").all() as EventRow[],
      footprint: db.prepare("SELECT * FROM footprint").all() as FootprintRow[],
    };
  } finally {
    db.close();
  }
}
