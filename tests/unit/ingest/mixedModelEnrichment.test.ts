// Ingest-level closure for F127/F128 (ISS-0019 review): the pure-parser
// mixed-model tests in enrichment.test.ts prove enrichFromTranscript's own
// per-request pricing, but F128 requires a SECOND test that drives it
// through real ingest — a hand-authored transcript file at a real path,
// referenced via `transcript_path` in a spool event, ingested with the real
// `ingest()` entry point (src/ingest/index.ts) — asserting the ledger
// COLUMNS end to end (sessions.tokens_*, cost_usd, model, and the cost
// absence row), not just enrichFromTranscript's return value in isolation.
//
// Below the seam: drives `ingest()` directly against a hand-authored spool
// file and a hand-authored transcript file, mirroring the established
// pattern in testResultsIdentity.test.ts and statusRecompute.test.ts (both
// unit-level, both bypassing the hook artifact and the CLI).
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore -- node:sqlite has no ambient types available in this sandbox (see src/core/ledger.ts)
import { DatabaseSync } from "node:sqlite";
import { ingest } from "../../../src/ingest/index.js";
import { getPaths } from "../../../src/core/paths.js";
import { COST_ABSENCE_REASONS } from "../../../src/core/absence.js";

function envelopeLine(ts: string, event: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, ts, event })}\n`;
}

function assistantLine(requestId: string, model: string, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: "assistant",
    requestId,
    version: "9.9.9",
    message: {
      model,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    },
  });
}

interface SessionEnrichmentRow {
  tokens_input: number | null;
  tokens_output: number | null;
  cost_usd: number | null;
  model: string | null;
}

function readSessionEnrichment(ledgerPath: string, sessionId: string): SessionEnrichmentRow {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT tokens_input, tokens_output, cost_usd, model FROM sessions WHERE session_id = ?")
      .get(sessionId) as SessionEnrichmentRow | undefined;
    if (!row) throw new Error(`test setup invariant: no session row for ${sessionId}`);
    return row;
  } finally {
    db.close();
  }
}

function readCostAbsenceReason(ledgerPath: string, sessionId: string): string | null {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT reason FROM absences WHERE session_id = ? AND facet = 'cost'")
      .get(sessionId) as { reason: string } | undefined;
    return row?.reason ?? null;
  } finally {
    db.close();
  }
}

describe("ingest: mixed-model transcript pricing, end to end (F127/F128)", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRepoRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iss0019-mixed-model-ingest-unit-"));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".coreartifact"), { recursive: true });
    return dir;
  }

  function writeTranscript(dir: string, lines: string[]): string {
    const transcriptPath = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
    return transcriptPath;
  }

  it("prices a real two-model transcript (fable-5 + haiku) at each request's own model through real ingest", async () => {
    const repoRoot = makeRepoRoot();
    const paths = getPaths(repoRoot);
    const sessionId = "unit-mixed-model-pinned";
    const ts = "2026-07-16T00:00:00.000Z";

    const transcriptPath = writeTranscript(repoRoot, [
      assistantLine("req_1", "claude-fable-5", 100, 100),
      assistantLine("req_2", "claude-haiku-4-5-20251001", 1_000_000, 1_000_000),
    ]);

    const lines =
      envelopeLine(ts, {
        session_id: sessionId,
        cwd: repoRoot,
        hook_event_name: "SessionStart",
        transcript_path: transcriptPath,
      }) +
      envelopeLine(ts, {
        session_id: sessionId,
        cwd: repoRoot,
        hook_event_name: "SessionEnd",
        reason: "other",
        transcript_path: transcriptPath,
      });

    fs.writeFileSync(paths.spool, lines);
    await ingest(repoRoot, { now: () => ts });

    const row = readSessionEnrichment(paths.ledger, sessionId);
    expect(row.tokens_input).toBe(1_000_100);
    expect(row.tokens_output).toBe(1_000_100);
    // Hand arithmetic (matches the unit-level pure-parser test):
    //   req_1 (claude-fable-5, 100 in / 100 out): (100*10 + 100*50)/1e6 = 0.006
    //   req_2 (claude-haiku-4-5-20251001, 1e6 in / 1e6 out): (1e6*1 + 1e6*5)/1e6 = 6.0
    //   total = 6.006 -- the OLD code priced ALL 1,000,100/1,000,100 tokens
    //   at the first model (claude-fable-5), yielding a fabricated 60.006.
    expect(row.cost_usd).toBeCloseTo(6.006, 9);
    // Two distinct models in one transcript -- no single "the model".
    expect(row.model).toBeNull();
    expect(readCostAbsenceReason(paths.ledger, sessionId)).toBeNull();
  });

  it("degrades cost to ABSENT (naming the unpinned model) through real ingest when the mix includes one, tokens still present", async () => {
    const repoRoot = makeRepoRoot();
    const paths = getPaths(repoRoot);
    const sessionId = "unit-mixed-model-unpinned";
    const ts = "2026-07-16T00:00:00.000Z";

    const transcriptPath = writeTranscript(repoRoot, [
      assistantLine("req_1", "claude-fable-5", 100, 100),
      assistantLine("req_2", "claude-opus-4-8", 1_000_000, 1_000_000), // unpinned
    ]);

    const lines =
      envelopeLine(ts, {
        session_id: sessionId,
        cwd: repoRoot,
        hook_event_name: "SessionStart",
        transcript_path: transcriptPath,
      }) +
      envelopeLine(ts, {
        session_id: sessionId,
        cwd: repoRoot,
        hook_event_name: "SessionEnd",
        reason: "other",
        transcript_path: transcriptPath,
      });

    fs.writeFileSync(paths.spool, lines);
    await ingest(repoRoot, { now: () => ts });

    const row = readSessionEnrichment(paths.ledger, sessionId);
    expect(row.tokens_input).toBe(1_000_100);
    expect(row.tokens_output).toBe(1_000_100);
    expect(row.cost_usd).toBeNull();
    expect(row.model).toBeNull();
    expect(readCostAbsenceReason(paths.ledger, sessionId)).toBe(
      COST_ABSENCE_REASONS.modelUnpinned("claude-opus-4-8"),
    );
  });
});
