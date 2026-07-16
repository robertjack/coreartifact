// Unit tests for the pure transcript parse (docs/issues/ISS-0019.md): the
// requestId dedup, the zoo-tolerant line skipping, and the exact oracle
// arithmetic — over the committed transcript fixtures and hand-authored
// drift shapes, never through the CLI (that's the acceptance suite's job).
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { enrichFromTranscript } from "../../../src/ingest/enrichment.js";
import { loadTranscriptPair } from "../../fixtures/loader.js";
import { COST_ABSENCE_REASONS } from "../../../src/core/absence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

function committedTranscriptPath(scenario: string): string {
  return path.join(REPO_ROOT, loadTranscriptPair(scenario).transcript);
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "iss19-enrichment-unit-"));
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

function writeTranscript(lines: unknown[]): string {
  const dir = makeTmpDir();
  const filePath = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return filePath;
}

function assistantLine(requestId: string, model: string, usage: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "assistant",
    requestId,
    version: "9.9.9",
    message: { model, usage },
  };
}

const FULL_USAGE = {
  input_tokens: 2,
  output_tokens: 3,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 7,
  cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 3 },
};

describe("enrichFromTranscript: transcript unavailable", () => {
  it("a null transcript path degrades to transcript unavailable", () => {
    const result = enrichFromTranscript(null);
    expect(result.tokensInput).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.costAbsenceReason).toBe(COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);
  });

  it("a nonexistent file path degrades to transcript unavailable, never throws", () => {
    const missing = path.join(makeTmpDir(), "nonexistent.jsonl");
    expect(fs.existsSync(missing)).toBe(false);
    const result = enrichFromTranscript(missing);
    expect(result.tokensInput).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.ccVersion).toBeNull();
    expect(result.costAbsenceReason).toBe(COST_ABSENCE_REASONS.TRANSCRIPT_UNAVAILABLE);
  });
});

describe("enrichFromTranscript: drifted shape", () => {
  it("assistant lines missing message.usage entirely degrade to transcript shape unrecognized", () => {
    const filePath = writeTranscript([
      { type: "assistant", requestId: "req_1", version: "2.1.211", message: { model: "claude-fable-5" } },
      { type: "assistant", requestId: "req_2", version: "2.1.211", message: { model: "claude-fable-5" } },
    ]);
    const result = enrichFromTranscript(filePath);
    expect(result.tokensInput).toBeNull();
    expect(result.costUsd).not.toBe(0);
    expect(result.costUsd).toBeNull();
    expect(result.costAbsenceReason).toBe(COST_ABSENCE_REASONS.TRANSCRIPT_SHAPE_UNRECOGNIZED);
  });

  it("a transcript with no assistant lines at all also degrades to transcript shape unrecognized", () => {
    const filePath = writeTranscript([{ type: "user", version: "2.1.211", message: { content: "hi" } }]);
    const result = enrichFromTranscript(filePath);
    expect(result.costAbsenceReason).toBe(COST_ABSENCE_REASONS.TRANSCRIPT_SHAPE_UNRECOGNIZED);
  });

  it("still records cc_version from a drifted transcript when a version field is present (independent facets)", () => {
    const filePath = writeTranscript([
      { type: "assistant", requestId: "req_1", version: "2.1.211", message: { model: "claude-fable-5" } },
    ]);
    const result = enrichFromTranscript(filePath);
    expect(result.ccVersion).toBe("2.1.211");
    expect(result.costAbsenceReason).toBe(COST_ABSENCE_REASONS.TRANSCRIPT_SHAPE_UNRECOGNIZED);
  });
});

describe("enrichFromTranscript: the zoo of unknown line types", () => {
  it("skips system/attachment/queue-operation/last-prompt lines silently and still parses the assistant lines", () => {
    const filePath = writeTranscript([
      { type: "queue-operation", operation: "enqueue" },
      { type: "attachment", version: "2.1.211" },
      { type: "system", version: "2.1.211" },
      { type: "last-prompt" },
      assistantLine("req_1", "claude-fable-5", FULL_USAGE),
    ]);
    const result = enrichFromTranscript(filePath);
    expect(result.tokensInput).toBe(2);
    expect(result.tokensOutput).toBe(3);
    expect(result.tokensCacheRead).toBe(5);
    expect(result.tokensCacheCreation).toBe(7);
    expect(result.costAbsenceReason).toBeNull();
  });

  it("tolerates a physically unparseable line (not valid JSON) rather than aborting the whole parse", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(filePath, `not json at all\n${JSON.stringify(assistantLine("req_1", "claude-fable-5", FULL_USAGE))}\n`);
    const result = enrichFromTranscript(filePath);
    expect(result.tokensInput).toBe(2);
    expect(result.costAbsenceReason).toBeNull();
  });
});

describe("enrichFromTranscript: requestId dedup", () => {
  it("sums usage once per distinct requestId, not once per repeating assistant line", () => {
    const filePath = writeTranscript([
      assistantLine("req_1", "claude-fable-5", FULL_USAGE),
      assistantLine("req_1", "claude-fable-5", FULL_USAGE), // repeat under the same requestId
      assistantLine("req_1", "claude-fable-5", FULL_USAGE), // repeat again
      assistantLine("req_2", "claude-fable-5", FULL_USAGE),
    ]);
    const result = enrichFromTranscript(filePath);
    // 2 distinct requests, not 4 repeated lines.
    expect(result.tokensInput).toBe(4);
    expect(result.tokensOutput).toBe(6);
    expect(result.tokensCacheRead).toBe(10);
    expect(result.tokensCacheCreation).toBe(14);
  });

  it("over the recovered headless dedup fixture (17 assistant lines, 7 distinct requestIds), the dedup sum differs from a naive per-line sum", () => {
    const transcriptPath = committedTranscriptPath("headless");
    const raw = fs.readFileSync(transcriptPath, "utf8");
    const lines = raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const assistantLines = lines.filter((l) => l.type === "assistant");
    expect(assistantLines.length).toBe(17);
    expect(new Set(assistantLines.map((l) => l.requestId)).size).toBe(7);

    const naiveInputSum = assistantLines.reduce(
      (sum, l) => sum + ((l.message as Record<string, unknown>).usage as Record<string, number>).input_tokens,
      0,
    );

    const result = enrichFromTranscript(transcriptPath);
    expect(result.tokensInput).not.toBeNull();
    expect(result.tokensInput).not.toBe(naiveInputSum);
  });
});

describe("enrichFromTranscript: exact oracle reproduction", () => {
  it.each([
    ["cost-headless", 0.555957],
    ["vitest", 0.438619],
    ["background", 0.674005],
  ])("reproduces the %s envelope oracle's total_cost_usd to the digit", (scenario, expectedCost) => {
    const pair = loadTranscriptPair(scenario);
    if (!pair.oracle) throw new Error(`test setup invariant: ${scenario} must carry an envelope oracle`);

    const result = enrichFromTranscript(committedTranscriptPath(scenario));
    expect(result.tokensInput).toBe(pair.oracle.usage.input_tokens);
    expect(result.tokensOutput).toBe(pair.oracle.usage.output_tokens);
    expect(result.tokensCacheRead).toBe(pair.oracle.usage.cache_read_input_tokens);
    expect(result.tokensCacheCreation).toBe(pair.oracle.usage.cache_creation_input_tokens);
    expect(result.costUsd).toBe(expectedCost);
    expect(result.model).toBe(pair.model);
    expect(result.ccVersion).toBe(pair.claudeCodeVersion);
    expect(result.costAbsenceReason).toBeNull();
  });
});

describe("enrichFromTranscript: unpinned model", () => {
  it("keeps tokens present and model recorded, but degrades cost to ABSENT naming the unpinned model", () => {
    const filePath = writeTranscript([assistantLine("req_1", "claude-sonnet-5", FULL_USAGE)]);
    const result = enrichFromTranscript(filePath);
    expect(result.tokensInput).toBe(2);
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.costUsd).toBeNull();
    expect(result.costAbsenceReason).toBe(COST_ABSENCE_REASONS.modelUnpinned("claude-sonnet-5"));
  });
});
