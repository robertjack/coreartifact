import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadManifest, loadFixtureStream, loadTranscriptPair, loadClaudeVersionOutputShape } from "../fixtures/loader.js";
import { replaySubstitutedTranscript } from "../fixtures/transcriptReplay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");
const SCENARIOS = [
  "interactive",
  "headless",
  "worktree",
  "SIGTERM",
  "SIGKILL",
  "cost-headless",
  "vitest",
  "background",
];
const REQUIRED_PAYLOAD_FIELDS = ["session_id", "hook_event_name", "cwd", "transcript_path"];

function readJsonLines(file: string) {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

describe("recording-pass fixture manifest", () => {
  it("lists exactly the eight scenarios: interactive, headless, worktree, SIGTERM, SIGKILL, cost-headless, vitest, background", () => {
    const manifest = loadManifest();
    const scenarios = manifest.streams.map((s) => s.scenario).sort();
    expect(scenarios).toEqual([...SCENARIOS].sort());
  });

  it("every stream is version-stamped, exists on disk, and its manifest events match the file's actual hook_event_name sequence", () => {
    const manifest = loadManifest();
    for (const scenario of SCENARIOS) {
      const entry = manifest.streams.find((s) => s.scenario === scenario);
      expect(entry, `manifest entry for "${scenario}"`).toBeTruthy();
      if (!entry) continue;

      expect(entry.claudeCodeVersion, `Claude Code version stamp for "${scenario}"`).toMatch(
        /^\d+\.\d+\.\d+$/,
      );
      expect(entry.events.length, `ordered hook events for "${scenario}"`).toBeGreaterThan(0);

      const filePath = path.join(REPO_ROOT, entry.file);
      expect(fs.existsSync(filePath), `stream file for "${scenario}" exists at ${filePath}`).toBe(true);

      const lines = readJsonLines(filePath);
      const actualEvents = lines.map((line) => JSON.parse(line).hook_event_name);
      expect(
        actualEvents,
        `manifest "events" for "${scenario}" must match ${entry.file}'s actual hook_event_name sequence`,
      ).toEqual(entry.events);
    }
  });

  it("every line of every stream is a JSON object carrying session_id, hook_event_name, cwd and transcript_path", () => {
    const manifest = loadManifest();
    const problems: string[] = [];

    for (const entry of manifest.streams) {
      const lines = readJsonLines(path.join(REPO_ROOT, entry.file));
      lines.forEach((line, idx) => {
        let payload: unknown;
        try {
          payload = JSON.parse(line);
        } catch {
          problems.push(`${entry.scenario} line ${idx + 1}: not valid JSON`);
          return;
        }
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          problems.push(`${entry.scenario} line ${idx + 1}: not a JSON object`);
          return;
        }
        for (const field of REQUIRED_PAYLOAD_FIELDS) {
          if (!(field in (payload as Record<string, unknown>))) {
            problems.push(`${entry.scenario} line ${idx + 1}: missing "${field}"`);
          }
        }
      });
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("the worktree stream records a WorktreeCreate payload", () => {
    const lines = loadFixtureStream("worktree");
    const worktreeCreate = lines.find((line) => JSON.parse(line).hook_event_name === "WorktreeCreate");
    expect(worktreeCreate, "a WorktreeCreate payload in the worktree stream").toBeTruthy();
  });

  it("loadFixtureStream throws a clear error for an unknown scenario", () => {
    expect(() => loadFixtureStream("bogus" as never)).toThrow(/no manifest entry/);
  });

  it("the corrupt-line fixture has an invalid middle line flanked by valid envelope-bearing payloads", () => {
    const file = path.join(FIXTURES_DIR, "corrupt-line.jsonl");
    expect(fs.existsSync(file), "corrupt-line.jsonl exists").toBe(true);

    const lines = readJsonLines(file);
    expect(lines.length).toBeGreaterThanOrEqual(3);

    const parsed = lines.map((line) => {
      try {
        return { ok: true as const, value: JSON.parse(line) };
      } catch {
        return { ok: false as const, value: undefined };
      }
    });

    const corruptIndices = parsed.map((r, idx) => (r.ok ? -1 : idx)).filter((idx) => idx !== -1);
    expect(corruptIndices.length).toBe(1);

    const corruptIdx = corruptIndices[0];
    expect(corruptIdx).toBeGreaterThan(0);
    expect(corruptIdx).toBeLessThan(lines.length - 1);

    for (const field of REQUIRED_PAYLOAD_FIELDS) {
      expect(parsed[corruptIdx - 1].value).toHaveProperty(field);
      expect(parsed[corruptIdx + 1].value).toHaveProperty(field);
    }
  });

  it("the corrupt-line fixture carries no manifest entry (unreachable through the loader)", () => {
    const manifest = loadManifest();
    const entry = manifest.streams.find((s) => s.file.endsWith("corrupt-line.jsonl"));
    expect(entry, "corrupt-line.jsonl must not appear in the typed manifest").toBeUndefined();
  });
});

describe("typed transcript-pair access", () => {
  const TRANSCRIPTS_MANIFEST_PATH = path.join(REPO_ROOT, "tests/fixtures/transcripts/manifest.json");

  function readRawTranscriptsManifest() {
    return JSON.parse(fs.readFileSync(TRANSCRIPTS_MANIFEST_PATH, "utf-8"));
  }

  it("exposes the recorded claude --version output shape", () => {
    const shape = loadClaudeVersionOutputShape();
    expect(shape).toBe(readRawTranscriptsManifest().claudeVersionOutput);
  });

  it("exposes oracle usage (total cost + four token classes) for cost-headless, vitest and background", () => {
    for (const scenario of ["cost-headless", "vitest", "background"]) {
      const rawPairs = readRawTranscriptsManifest().pairs as any[];
      const rawPair = rawPairs.find((p) => p.scenario === scenario);
      const typedPair = loadTranscriptPair(scenario);

      expect(typedPair.oracle, `"${scenario}" oracle`).toBeTruthy();
      expect(typedPair.oracle?.total_cost_usd).toBe(rawPair.oracle.total_cost_usd);
      expect(typedPair.oracle?.usage.input_tokens).toBe(rawPair.oracle.usage.input_tokens);
      expect(typedPair.oracle?.usage.output_tokens).toBe(rawPair.oracle.usage.output_tokens);
      expect(typedPair.oracle?.usage.cache_read_input_tokens).toBe(rawPair.oracle.usage.cache_read_input_tokens);
      expect(typedPair.oracle?.usage.cache_creation_input_tokens).toBe(
        rawPair.oracle.usage.cache_creation_input_tokens,
      );

      const streamPath = path.join(REPO_ROOT, typedPair.stream);
      const transcriptPath = path.join(REPO_ROOT, typedPair.transcript);
      expect(fs.existsSync(streamPath), `"${scenario}" stream file exists`).toBe(true);
      expect(fs.existsSync(transcriptPath), `"${scenario}" transcript file exists`).toBe(true);
    }
  });

  it("exposes a null oracle for the recovered headless and interactive pairs", () => {
    for (const scenario of ["headless", "interactive"]) {
      const typedPair = loadTranscriptPair(scenario);
      expect(typedPair.oracle, `recovered "${scenario}" oracle must be null`).toBeNull();
      const transcriptPath = path.join(REPO_ROOT, typedPair.transcript);
      expect(fs.existsSync(transcriptPath), `recovered "${scenario}" transcript file exists`).toBe(true);
    }
  });

  it("throws a clear error for an unknown scenario", () => {
    expect(() => loadTranscriptPair("bogus")).toThrow(/no transcript pair/);
  });
});

describe("transcript-substituting replay wrapper", () => {
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

  function sha256(filePath: string): string {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  }

  it("rewrites transcript_path to a tmpdir copy, leaves every other byte unchanged, and leaves committed fixtures byte-verbatim", async () => {
    const committedStream = path.join(REPO_ROOT, "tests/fixtures/background.jsonl");
    const committedTranscript = path.join(REPO_ROOT, "tests/fixtures/transcripts/background.transcript.jsonl");

    const streamBefore = fs.readFileSync(committedStream);
    const transcriptBefore = fs.readFileSync(committedTranscript);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "coreartifact-fixtures-transcript-replay-"));
    const stubPath = path.join(workDir, "stub.cjs");
    const resultsFile = path.join(workDir, "results.ndjson");
    fs.writeFileSync(stubPath, STUB_SCRIPT);
    fs.writeFileSync(resultsFile, "");

    try {
      const result = await replaySubstitutedTranscript("background", workDir, ["node", stubPath, resultsFile]);
      expect(result.invocations.length).toBeGreaterThan(0);

      const recorded = fs
        .readFileSync(resultsFile, "utf-8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { text: string }).text);

      const originalLines = readJsonLines(committedStream);
      expect(recorded.length).toBe(originalLines.length);

      for (let i = 0; i < recorded.length; i += 1) {
        const delivered = JSON.parse(recorded[i]);
        const original = JSON.parse(originalLines[i]);

        expect(typeof delivered.transcript_path === "string" && delivered.transcript_path.startsWith(workDir)).toBe(
          true,
        );
        expect(delivered.transcript_path).not.toBe(original.transcript_path);

        const { transcript_path: _dtp, ...deliveredRest } = delivered;
        const { transcript_path: _otp, ...originalRest } = original;
        expect(deliveredRest).toEqual(originalRest);
      }

      expect(fs.existsSync(result.transcriptPath)).toBe(true);
      expect(fs.readFileSync(result.transcriptPath).equals(transcriptBefore)).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    expect(fs.readFileSync(committedStream).equals(streamBefore)).toBe(true);
    expect(fs.readFileSync(committedTranscript).equals(transcriptBefore)).toBe(true);
  });

  it("supports a truncated prefix of the stream (background-outcome slice needs this)", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "coreartifact-fixtures-transcript-replay-prefix-"));
    const stubPath = path.join(workDir, "stub.cjs");
    const resultsFile = path.join(workDir, "results.ndjson");
    fs.writeFileSync(stubPath, STUB_SCRIPT);
    fs.writeFileSync(resultsFile, "");

    try {
      const result = await replaySubstitutedTranscript("background", workDir, ["node", stubPath, resultsFile], 3);
      expect(result.invocations.length).toBe(3);
      expect(result.lines.length).toBe(3);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
