// ISS-0016 acceptance test — the sanctioned substitution: a fixtures-owned
// transcript-substituting replay wrapper at tests/fixtures/transcriptReplay.ts.
// That module does not exist yet, so it is loaded through a dynamic import
// behind a non-literal specifier (MODULE_PATH) — a literal specifier in a
// dynamic import lets tsc try to resolve the (currently missing) module and
// fail the whole file at collection instead of producing a red assertion.
//
// The wrapper composes the acceptance harness's existing explicit-lines replay
// primitive (replayLines) by import only — the harness itself
// (tests/acceptance/harness/, tests/acceptance/harness.test.ts) is outside this
// issue's footprint and must stay byte-unchanged, which this test verifies
// directly by hashing the harness directory before and after a replay.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const MODULE_PATH = "../../fixtures/transcriptReplay.js";

const COMMITTED_STREAM = path.join(REPO_ROOT, "tests/fixtures/background.jsonl");
const COMMITTED_TRANSCRIPT = path.join(REPO_ROOT, "tests/fixtures/transcripts/background.transcript.jsonl");
const HARNESS_DIR = path.join(REPO_ROOT, "tests/acceptance/harness");

const STUB_SCRIPT = `
const fs = require('node:fs');
const resultsFile = process.argv[2];
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const payload = Buffer.concat(chunks);
  fs.appendFileSync(resultsFile, JSON.stringify({ text: payload.toString('utf8') }) + '\\n');
  process.exit(0);
});
`;

async function importTranscriptReplayModule(): Promise<any> {
  try {
    return await import(MODULE_PATH);
  } catch {
    return undefined;
  }
}

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, hashTree(full));
    } else {
      out[full] = sha256(full);
    }
  }
  return out;
}

function readNonEmptyLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

describe("ISS-0016 transcript-substituting replay wrapper", () => {
  it("The transcript-substituting replay wrapper copies the paired transcript into the test tmpdir, rewrites transcript_path in each delivered payload to that copy, and delivers through the harness's existing explicit-lines replay primitive with all other payload bytes unchanged; after a substituted replay, the committed stream and transcript fixture files and every file under the acceptance harness are byte-identical to their committed state.", async () => {
    const mod = await importTranscriptReplayModule();
    if (!mod || typeof mod.replaySubstitutedTranscript !== "function") {
      throw new Error(
        "tests/fixtures/transcriptReplay.ts does not yet export replaySubstitutedTranscript — not implemented",
      );
    }

    const streamBefore = fs.readFileSync(COMMITTED_STREAM);
    const transcriptBefore = fs.readFileSync(COMMITTED_TRANSCRIPT);
    const harnessBefore = hashTree(HARNESS_DIR);

    const workDir = fs.mkdtempSync(path.join(tmpdir(), "coreartifact-iss0016-transcript-replay-"));
    const stubPath = path.join(workDir, "stub.cjs");
    const resultsFile = path.join(workDir, "results.ndjson");
    fs.writeFileSync(stubPath, STUB_SCRIPT);
    fs.writeFileSync(resultsFile, "");

    try {
      const result = await mod.replaySubstitutedTranscript("background", workDir, ["node", stubPath, resultsFile]);
      expect(result?.invocations?.length, "the wrapper reports at least one invocation").toBeGreaterThan(0);

      const recorded = fs
        .readFileSync(resultsFile, "utf-8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { text: string }).text);

      const originalLines = readNonEmptyLines(COMMITTED_STREAM);
      expect(recorded.length, "one delivered payload per original stream line").toBe(originalLines.length);

      let tmpTranscriptPathSeen: string | undefined;
      for (let i = 0; i < recorded.length; i += 1) {
        const delivered = JSON.parse(recorded[i]);
        const original = JSON.parse(originalLines[i]);

        expect(
          typeof delivered.transcript_path === "string" && delivered.transcript_path.startsWith(workDir),
          `line ${i + 1}: transcript_path must be rewritten to point inside the tmpdir ${workDir}`,
        ).toBe(true);
        expect(
          delivered.transcript_path,
          `line ${i + 1}: transcript_path must not still be the committed fixture path`,
        ).not.toBe(original.transcript_path);
        tmpTranscriptPathSeen = delivered.transcript_path;

        // Operator amendment 2026-07-16 (review S2): the criterion says
        // BYTES unchanged — comparing reparsed objects let a reformat
        // (e.g. pretty-printed JSON) through undetected. The expected
        // delivered line is the original raw line with only the
        // JSON-encoded transcript_path value substituted.
        const expectedLine = originalLines[i].replace(
          JSON.stringify(original.transcript_path),
          JSON.stringify(delivered.transcript_path),
        );
        expect(
          recorded[i],
          `line ${i + 1}: every payload byte other than transcript_path is unchanged`,
        ).toBe(expectedLine);
      }

      expect(tmpTranscriptPathSeen, "at least one delivered payload was inspected").toBeTruthy();
      if (tmpTranscriptPathSeen) {
        expect(fs.existsSync(tmpTranscriptPathSeen), "the rewritten transcript_path exists in the tmpdir").toBe(true);
        const tmpCopyBytes = fs.readFileSync(tmpTranscriptPathSeen);
        expect(
          tmpCopyBytes.equals(transcriptBefore),
          "the tmpdir transcript copy's bytes equal the committed transcript fixture's bytes",
        ).toBe(true);
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    expect(
      fs.readFileSync(COMMITTED_STREAM).equals(streamBefore),
      "the committed stream fixture is byte-identical to its committed state after the substituted replay",
    ).toBe(true);
    expect(
      fs.readFileSync(COMMITTED_TRANSCRIPT).equals(transcriptBefore),
      "the committed transcript fixture is byte-identical to its committed state after the substituted replay",
    ).toBe(true);
    expect(
      hashTree(HARNESS_DIR),
      "every file under the acceptance harness is byte-identical to its committed state after the substituted replay",
    ).toEqual(harnessBefore);
  });
});
